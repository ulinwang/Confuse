import {
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
};

// Keep the multi-granule read bounded; a failed chunk is reported without
// preventing later chunks in the same flush.
const CHUNK = 64;
const FLUSH_BYTES = 64 * 1024 * 1024;
const SETTLE_MS = 5_000;
const MAX_AGE_MS = 30_000;
// Sparse traffic is normally read within the 30s age cutoff plus one 5s tick.
const TICK_MS = 5_000;
const MAX_ROWS = 16_384;
const MAX_BYTES = 8 * 1024 * 1024;
const METRIC = "langfuse.ingestion.otel.shadow.row_verification";
const READ_ERROR = "langfuse.ingestion.otel.shadow.verification_read_error";
type Side = "primary" | "shadow";
type Key = [string, string, string, string, string];
type Locator = {
  key: Key;
  jobId?: string;
  primaryAcks: number;
  shadowAcks: number;
  firstBatch: number;
  multipleBatches: boolean;
};
type Stored = {
  side: Side;
  position: number;
  copies: number | string;
  fields: Record<string, string>;
  sortedMaps: string[];
};

const sides = ["primary", "shadow"] as const;
const maps = [
  "provided_usage_details",
  "usage_details",
  "provided_cost_details",
  "cost_details",
  "tool_definitions",
];
const clocks = "created_at, updated_at, event_ts";
const identity =
  "(e.project_id, e.trace_id, e.span_id, e.start_time, e.blob_storage_file_path)";
const columns = `e.* EXCEPT (${clocks})`;

function sideQuery(table: string, side: Side): string {
  const fields = `any(mapFromArrays(tupleNames(tuple(${columns})), [${columns} APPLY(x -> hex(sipHash128(tuple(x))))])) AS fields`;
  const sorted = `any([${maps.map((name) => `hex(sipHash128(mapSort(e.${name})))`).join(", ")}]) AS sortedMaps`;
  return `SELECT '${side}' AS side, indexOf(keys, ${identity}) AS position,
    count() AS copies, ${fields}, ${sorted}
FROM ${table} AS e
WHERE (e.project_id, toStartOfMinute(e.start_time), xxHash32(e.trace_id)) IN
  (SELECT k.1, toStartOfMinute(k.4), xxHash32(k.2)
   FROM (SELECT arrayJoin(keys) AS k))
  AND ${identity} IN keys
GROUP BY position`;
}

async function readHashes(keys: Key[]): Promise<Map<number, Stored[]>> {
  const rows = await withCustomerDataLoggingSuppressed(() =>
    queryClickhouse<Stored>({
      query: `WITH {locators:Array(Tuple(String,String,String,DateTime64(6,'UTC'),String))} AS keys
${sideQuery("events_full", "primary")}
UNION ALL
${sideQuery("events_native_test", "shadow")}`,
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
  return Map.groupBy(rows, (row) => Number(row.position) - 1);
}

function collect(
  samples: readonly OtelShadowRowSample[],
): Map<string, Locator> {
  const locators = new Map<string, Locator>();
  for (const [batch, sample] of samples.entries()) {
    for (const side of sides) {
      for (const row of sample[side]) {
        const startTime = shadowStoredTime(row.startTime);
        if (startTime === undefined)
          throw new Error("Invalid shadow start time");
        const key: Key = [
          sample.projectId,
          row.traceId,
          row.spanId,
          startTime,
          sample.fileKey,
        ];
        const id = JSON.stringify(key);
        const item = locators.get(id) ?? {
          key,
          jobId:
            sample.jobId === undefined ? undefined : shadowJobId(sample.jobId),
          primaryAcks: 0,
          shadowAcks: 0,
          firstBatch: batch,
          multipleBatches: false,
        };
        if (item.firstBatch !== batch) item.multipleBatches = true;
        if (side === "primary") item.primaryAcks++;
        else item.shadowAcks++;
        locators.set(id, item);
      }
    }
  }
  return locators;
}

function compareFields(primary: Stored, shadow: Stored) {
  const changed: string[] = [];
  const orderOnly: string[] = [];
  for (const name of new Set([
    ...Object.keys(primary.fields),
    ...Object.keys(shadow.fields),
  ])) {
    if (primary.fields[name] === shadow.fields[name]) continue;
    const index = maps.indexOf(name);
    if (index >= 0 && primary.sortedMaps[index] === shadow.sortedMaps[index])
      orderOnly.push(name);
    else changed.push(name);
  }
  changed.sort();
  orderOnly.sort();
  return { changedColumns: changed, orderOnlyColumns: orderOnly };
}

async function verify(samples: readonly OtelShadowRowSample[]): Promise<{
  counts: Record<string, number>;
  examples: OtelShadowRowDifference[];
  readErrors: number;
}> {
  const locators = [...collect(samples).values()];
  const counts: Record<string, number> = {};
  const examples: Partial<Record<string, OtelShadowRowDifference>> = {};
  let readErrors = 0;
  for (let offset = 0; offset < locators.length; offset += CHUNK) {
    const chunk = locators.slice(offset, offset + CHUNK);
    let hashes: Map<number, Stored[]> | undefined;
    try {
      hashes = await readHashes(chunk.map(({ key }) => key));
    } catch {
      readErrors += chunk.length;
    }
    for (const [index, item] of chunk.entries()) {
      const rows = hashes?.get(index) ?? [];
      const primary = rows.find(({ side }) => side === "primary");
      const shadow = rows.find(({ side }) => side === "shadow");
      const primaryCopies = Number(primary?.copies ?? 0);
      const shadowCopies = Number(shadow?.copies ?? 0);
      let outcome = "read_error";
      let fields: ReturnType<typeof compareFields> | undefined;
      if (hashes) {
        const ambiguous =
          item.multipleBatches ||
          item.primaryAcks > 1 ||
          item.shadowAcks > 1 ||
          primaryCopies > 1 ||
          shadowCopies > 1 ||
          (primary !== undefined && item.primaryAcks === 0) ||
          (shadow !== undefined && item.shadowAcks === 0);
        if (ambiguous) outcome = "ambiguous";
        else if (primary === undefined && shadow === undefined)
          outcome = "missing_both";
        else if (primary === undefined) outcome = "missing_primary";
        else if (shadow === undefined) outcome = "missing_shadow";
        else {
          fields = compareFields(primary, shadow);
          if (fields.changedColumns.length > 0) outcome = "different";
          else if (fields.orderOnlyColumns.length > 0)
            outcome = "map_order_only";
          else outcome = "matched";
        }
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      if (outcome === "matched" || examples[outcome] !== undefined) continue;
      const [projectId, traceId, spanId, startTime] = item.key;
      examples[outcome] = {
        outcome,
        rowKey: shadowRowKey(projectId, { traceId, spanId, startTime }),
        jobId: item.jobId,
        primaryAcks: item.primaryAcks,
        shadowAcks: item.shadowAcks,
        primaryCopies,
        shadowCopies,
        ...fields,
      };
    }
  }
  return {
    counts,
    examples: Object.values(examples).filter(
      (example): example is OtelShadowRowDifference => example !== undefined,
    ),
    readErrors,
  };
}

type Pending = {
  sample: OtelShadowRowSample;
  at: number;
  bytes: number;
  rows: number;
};
const pending: Pending[] = [];
let retainedBytes = 0;
let retainedRows = 0;
let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;

function sizeOf(sample: OtelShadowRowSample): number {
  let bytes =
    Buffer.byteLength(sample.projectId) + Buffer.byteLength(sample.fileKey);
  for (const side of sides) {
    for (const row of sample[side]) {
      bytes +=
        128 +
        Buffer.byteLength(row.traceId) +
        Buffer.byteLength(row.spanId) +
        Buffer.byteLength(row.startTime);
    }
  }
  return bytes;
}

function arm(): void {
  if (timer !== undefined || active !== undefined || pending.length === 0)
    return;
  timer = setTimeout(() => {
    timer = undefined;
    flush(false);
  }, TICK_MS);
  timer.unref();
}

function flush(force: boolean): void {
  if (active !== undefined || pending.length === 0) return;
  const now = Date.now();
  const cutoff = force ? Infinity : now - SETTLE_MS;
  let bytes = 0;
  let count = 0;
  while (
    count < pending.length &&
    pending[count].at <= cutoff &&
    bytes < FLUSH_BYTES
  ) {
    bytes += pending[count].sample.inputBytes;
    count++;
  }
  if (
    count === 0 ||
    (!force && pending[0].at + MAX_AGE_MS > now && bytes < FLUSH_BYTES)
  ) {
    arm();
    return;
  }
  const group = pending.splice(0, count);
  active = verify(group.map(({ sample }) => sample))
    .then(({ counts, examples, readErrors }) => {
      for (const [outcome, rows] of Object.entries(counts))
        recordIncrement(METRIC, rows, { outcome });
      if (readErrors > 0) {
        recordIncrement(READ_ERROR, readErrors);
        logger.warn("OTEL shadow persisted-row verification query failed", {
          batches: group.length,
        });
      }
      if (examples.length > 0)
        logger.info(
          "OTEL shadow persisted rows differ or could not be attributed",
          { counts, examples },
        );
    })
    .catch(() => {
      recordIncrement(READ_ERROR, 1);
      logger.warn("OTEL shadow persisted-row verification query failed", {
        batches: group.length,
      });
    })
    .finally(() => {
      for (const item of group) {
        retainedRows -= item.rows;
        retainedBytes -= item.bytes;
      }
      active = undefined;
      arm();
    });
}

export function enqueueShadowRows(sample: OtelShadowRowSample): void {
  const rows = sample.primary.length + sample.shadow.length;
  if (rows === 0) return;
  const bytes = sizeOf(sample);
  if (retainedRows + rows > MAX_ROWS || retainedBytes + bytes > MAX_BYTES) {
    recordIncrement(METRIC, rows, { outcome: "capacity" });
    return;
  }
  pending.push({ sample, at: Date.now(), bytes, rows });
  retainedRows += rows;
  retainedBytes += bytes;
  arm();
}

export async function drainShadowRows(): Promise<void> {
  while (active !== undefined || pending.length > 0) {
    clearTimeout(timer);
    timer = undefined;
    flush(true);
    if (active !== undefined) await active;
  }
}
