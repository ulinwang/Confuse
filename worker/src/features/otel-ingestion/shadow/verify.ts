import {
  eventRecordReadSchema,
  logger,
  queryClickhouse,
  recordIncrement,
  TupleParam,
  withCustomerDataLoggingSuppressed,
} from "@langfuse/shared/src/server";

import {
  shadowJobId,
  shadowRowKey,
  shadowStoredTime,
  type OtelShadowRowLocator,
} from "./rowKey";

export type OtelShadowRowSample = {
  projectId: string;
  fileKey: string;
  jobId?: string;
  inputBytes: number;
  primary: readonly OtelShadowRowLocator[];
  shadow: readonly OtelShadowRowLocator[];
};

export type OtelShadowRowDifference = {
  outcome: string;
  rowKey: ReturnType<typeof shadowRowKey>;
  jobId?: string;
  primaryAcks: number;
  shadowAcks: number;
  primaryCopies: number;
  shadowCopies: number;
  changedColumns?: string[];
  orderOnlyColumns?: string[];
  fieldDetails?: "unavailable" | "changed_since_read";
};

const READ_BATCH_BYTES = 64 * 1024 * 1024;
const SETTLE_MS = 5_000;
const MAX_AGE_MS = 30_000;
// The lazy tick makes sparse verification roughly 30s + one tick (at most 35s
// under normal timer delivery), instead of maintaining exact per-batch timers.
const TICK_MS = 5_000;
const KEYS_PER_QUERY = 512;
const MAX_RETAINED_ROWS = 16_384;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

type Identity = [string, string, string, string, string];
type Expected = {
  key: Identity;
  sampleIndex: number;
  repeated: boolean;
  primary: number;
  shadow: number;
};
type Side = "primary" | "shadow";
type Stored = {
  side: Side;
  position: number;
  copies: string | number;
  digest: string;
  mapDigest: string;
};
type StoredFields = Pick<Stored, "side" | "position" | "copies"> & {
  columnDigests: Record<string, string>;
  sortedMaps: string[];
};
type VerificationResult = {
  counts: Record<string, number>;
  examples: OtelShadowRowDifference[];
};

// Include the ingestion file so a retry of another delivery with the same span
// cannot satisfy this lookup.
const rowIdentity =
  "(e.project_id, e.trace_id, e.span_id, e.start_time, e.blob_storage_file_path)";
const sourceTables = [
  ["events_full", "primary"],
  ["events_native_test", "shadow"],
] as const;
const eventMaps = [
  "provided_usage_details",
  "usage_details",
  "provided_cost_details",
  "cost_details",
  "tool_definitions",
];
const excludedClocks = "created_at, updated_at, event_ts";
const columns = `e.* EXCEPT (${excludedClocks})`;

function readSide(
  table: "events_full" | "events_native_test",
  side: Side,
  details: boolean,
): string {
  // Hash values inside ClickHouse. The worker receives counts and digests,
  // including per-column digests for the rows selected for diagnosis.
  const hashes = details
    ? `any(mapFromArrays(tupleNames(tuple(${columns})), [${columns} APPLY(x -> hex(sipHash128(tuple(x))))])) AS columnDigests,
       any([${eventMaps.map((name) => `hex(sipHash128(mapSort(e.${name})))`).join(", ")}]) AS sortedMaps`
    : `any(hex(sipHash128(tuple(e.* EXCEPT (${excludedClocks}, ${eventMaps.join(", ")})),
       ${eventMaps.map((name) => `mapSort(e.${name})`).join(", ")}))) AS digest,
       any(hex(sipHash128(${eventMaps.map((name) => `e.${name}`).join(", ")}))) AS mapDigest`;

  return `
    SELECT '${side}' AS side, indexOf(keys, ${rowIdentity}) AS position, count() AS copies, ${hashes}
    FROM ${table} AS e
    WHERE (e.project_id, toStartOfMinute(e.start_time), xxHash32(e.trace_id)) IN
      (SELECT k.1, toStartOfMinute(k.4), xxHash32(k.2) FROM (SELECT arrayJoin(keys) AS k))
    AND ${rowIdentity} IN keys
    GROUP BY position`;
}

async function readPairs<T extends Pick<Stored, "side" | "position">>(
  keys: Identity[],
  details: boolean,
): Promise<Partial<Record<Side, T>>[]> {
  const pairs = keys.map((): Partial<Record<Side, T>> => ({}));
  const rows = await withCustomerDataLoggingSuppressed(() =>
    queryClickhouse<T>({
      query: `WITH {locators:Array(Tuple(String,String,String,DateTime64(6,'UTC'),String))} AS keys
      ${sourceTables.map(([table, side]) => readSide(table, side, details)).join(" UNION ALL ")}`,
      params: { locators: keys.map((key) => new TupleParam(key)) },
      useMultipartParamsAuto: true,
      preferredClickhouseService: "ReadWrite",
      tags: { surface: "worker", route: "otel-shadow-verify-rows" },
      clickhouseSettings: {
        max_threads: 2,
        max_execution_time: 8,
        max_bytes_to_read: "536870912",
        max_result_rows: String(keys.length * 2),
        result_overflow_mode: "throw",
        asterisk_include_materialized_columns: 1,
        asterisk_include_alias_columns: 1,
        enable_named_columns_in_function_tuple: 1,
        log_queries: 0,
      },
    }),
  );

  for (const row of rows) pairs[row.position - 1][row.side] = row;
  return pairs;
}

function addExpected(
  expected: Map<string, Expected>,
  sampleIndex: number,
  side: Side,
  row: OtelShadowRowLocator,
  sample: OtelShadowRowSample,
): void {
  const startTime = shadowStoredTime(row.startTime);
  if (startTime === undefined) throw new Error("Invalid shadow start time");
  const key: Identity = [
    sample.projectId,
    row.traceId,
    row.spanId,
    startTime,
    sample.fileKey,
  ];
  const id = JSON.stringify(key);
  const entry = expected.get(id) ?? {
    key,
    sampleIndex,
    repeated: false,
    primary: 0,
    shadow: 0,
  };
  if (entry.sampleIndex !== sampleIndex) entry.repeated = true;
  entry[side]++;
  expected.set(id, entry);
}

async function describeChangedFields(
  examples: { key: Identity; example: OtelShadowRowDifference }[],
): Promise<void> {
  const changed = examples.filter(
    ({ example }) =>
      example.outcome === "different" || example.outcome === "map_order_only",
  );
  if (changed.length === 0) return;

  try {
    const pairs = await readPairs<StoredFields>(
      changed.map(({ key }) => key),
      true,
    );
    pairs.forEach(({ primary, shadow }, index) => {
      const { example } = changed[index];
      if (
        primary === undefined ||
        shadow === undefined ||
        Number(primary.copies) !== 1 ||
        Number(shadow.copies) !== 1
      ) {
        example.fieldDetails = "changed_since_read";
        return;
      }

      const changedColumns = new Set<string>();
      const orderOnlyColumns: string[] = [];
      const names = new Set([
        ...Object.keys(primary.columnDigests),
        ...Object.keys(shadow.columnDigests),
      ]);
      for (const name of names) {
        if (primary.columnDigests[name] === shadow.columnDigests[name])
          continue;
        const mapIndex = eventMaps.indexOf(name);
        if (
          mapIndex >= 0 &&
          primary.sortedMaps[mapIndex] === shadow.sortedMaps[mapIndex]
        ) {
          orderOnlyColumns.push(name);
        } else {
          changedColumns.add(
            Object.hasOwn(eventRecordReadSchema.shape, name)
              ? name
              : "unmapped_column",
          );
        }
      }

      example.changedColumns = [...changedColumns].sort();
      example.orderOnlyColumns = orderOnlyColumns.sort();
      if (
        (example.outcome === "different") !== changedColumns.size > 0 ||
        (changedColumns.size === 0 && orderOnlyColumns.length === 0)
      ) {
        example.fieldDetails = "changed_since_read";
      }
    });
  } catch {
    for (const { example } of changed) example.fieldDetails = "unavailable";
  }
}

async function verifyRows(
  samples: readonly OtelShadowRowSample[],
): Promise<VerificationResult> {
  const expected = new Map<string, Expected>();
  for (const [sampleIndex, sample] of samples.entries()) {
    for (const side of ["primary", "shadow"] as const) {
      for (const row of sample[side]) {
        addExpected(expected, sampleIndex, side, row, sample);
      }
    }
  }

  const counts: Record<string, number> = {};
  const examples = new Map<
    string,
    { key: Identity; example: OtelShadowRowDifference }
  >();
  const keys = Array.from(expected.values());
  for (let index = 0; index < keys.length; index += KEYS_PER_QUERY) {
    const chunk = keys.slice(index, index + KEYS_PER_QUERY);
    const pairs = await readPairs<Stored>(
      chunk.map(({ key }) => key),
      false,
    );
    for (const [pairIndex, entry] of chunk.entries()) {
      const { primary, shadow } = pairs[pairIndex];
      const primaryAcks = entry.primary;
      const shadowAcks = entry.shadow;
      const primaryCopies = Number(primary?.copies ?? 0);
      const shadowCopies = Number(shadow?.copies ?? 0);
      const ambiguous =
        entry.repeated ||
        primaryAcks > 1 ||
        shadowAcks > 1 ||
        primaryCopies > 1 ||
        shadowCopies > 1 ||
        (primary !== undefined && primaryAcks === 0) ||
        (shadow !== undefined && shadowAcks === 0);

      let outcome: string;
      if (ambiguous) outcome = "ambiguous";
      else if (primary === undefined && shadow === undefined)
        outcome = "missing_both";
      else if (primary === undefined) outcome = "missing_primary";
      else if (shadow === undefined) outcome = "missing_shadow";
      else if (primary.digest !== shadow.digest) outcome = "different";
      else
        outcome =
          primary.mapDigest === shadow.mapDigest ? "matched" : "map_order_only";

      counts[outcome] = (counts[outcome] ?? 0) + 1;
      if (outcome === "matched" || examples.has(outcome)) continue;
      const [projectId, traceId, spanId, startTime] = entry.key;
      examples.set(outcome, {
        key: entry.key,
        example: {
          outcome,
          rowKey: shadowRowKey(projectId, { traceId, spanId, startTime }),
          jobId: samples[entry.sampleIndex].jobId
            ? shadowJobId(samples[entry.sampleIndex].jobId!)
            : undefined,
          primaryAcks,
          shadowAcks,
          primaryCopies,
          shadowCopies,
        },
      });
    }
  }

  const exampleEntries = [...examples.values()];
  await describeChangedFields(exampleEntries);
  return {
    counts,
    examples: exampleEntries.map(({ example }) => example),
  };
}

type Pending = {
  sample: OtelShadowRowSample;
  enqueuedAt: number;
  retainedBytes: number;
  rows: number;
};

const pending: Pending[] = [];
let retainedBytes = 0;
let retainedRows = 0;
let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;

function retainedBytesFor(sample: OtelShadowRowSample): number {
  let bytes =
    Buffer.byteLength(sample.projectId) + Buffer.byteLength(sample.fileKey);
  for (const side of [sample.primary, sample.shadow]) {
    for (const row of side) {
      bytes +=
        128 +
        Buffer.byteLength(row.traceId) +
        Buffer.byteLength(row.spanId) +
        Buffer.byteLength(row.startTime);
    }
  }
  return bytes;
}

export function enqueueShadowRows(sample: OtelShadowRowSample): void {
  const rows = sample.primary.length + sample.shadow.length;
  if (rows === 0) return;
  const bytes = retainedBytesFor(sample);
  if (
    retainedRows + rows > MAX_RETAINED_ROWS ||
    retainedBytes + bytes > MAX_RETAINED_BYTES
  ) {
    recordIncrement("langfuse.ingestion.otel.shadow.row_verification", rows, {
      outcome: "capacity",
    });
    return;
  }

  const enqueuedAt = Date.now();
  pending.push({ sample, enqueuedAt, retainedBytes: bytes, rows });
  retainedRows += rows;
  retainedBytes += bytes;
  scheduleTick();
}

function scheduleTick(): void {
  if (timer !== undefined || active !== undefined || pending.length === 0)
    return;
  timer = setTimeout(() => {
    timer = undefined;
    startRead(false);
    scheduleTick();
  }, TICK_MS);
  timer.unref();
}

function startRead(force: boolean): void {
  if (active !== undefined || pending.length === 0) return;

  const now = Date.now();
  const readyBefore = force ? Infinity : now - SETTLE_MS;
  let inputBytes = 0;
  let count = 0;
  while (
    count < pending.length &&
    pending[count].enqueuedAt <= readyBefore &&
    inputBytes < READ_BATCH_BYTES
  ) {
    inputBytes += pending[count].sample.inputBytes;
    count++;
  }

  const oldestIsDue = pending[0].enqueuedAt + MAX_AGE_MS <= now;
  const batchIsReady = inputBytes >= READ_BATCH_BYTES;
  if (count === 0 || (!force && !oldestIsDue && !batchIsReady)) {
    return;
  }

  const group = pending.splice(0, count);
  active = verifyRows(group.map(({ sample }) => sample))
    .then(({ counts, examples }) => {
      for (const [outcome, rows] of Object.entries(counts)) {
        recordIncrement(
          "langfuse.ingestion.otel.shadow.row_verification",
          rows,
          { outcome },
        );
      }
      if (examples.length > 0) {
        logger.info(
          "OTEL shadow persisted rows differ or could not be attributed",
          { counts, examples },
        );
      }
    })
    .catch(() => {
      recordIncrement(
        "langfuse.ingestion.otel.shadow.verification_read_error",
        1,
      );
      logger.warn("OTEL shadow persisted-row verification query failed", {
        batches: group.length,
      });
    })
    .finally(() => {
      for (const item of group) {
        retainedRows -= item.rows;
        retainedBytes -= item.retainedBytes;
      }
      active = undefined;
      scheduleTick();
    });
}

export async function drainShadowRows(): Promise<void> {
  while (active !== undefined || pending.length > 0) {
    clearTimeout(timer);
    timer = undefined;
    startRead(true);
    if (active !== undefined) await active;
  }
}
