import { xxh32 } from "@node-rs/xxhash";

export type OtelShadowRowLocator = {
  traceId: string;
  spanId: string;
  startTime: string;
};

// The TypeScript and native writers use UTC with different separators and
// precision. Keep one canonical value for the ClickHouse lookup and diagnostics.
export function shadowStoredTime(value: string): string | undefined {
  const match =
    /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z?$/.exec(value);
  return match
    ? `${match[1]} ${match[2]}.${(match[3] ?? "").padEnd(6, "0").slice(0, 6)}`
    : undefined;
}

// The table's sort key uses xxHash32(trace_id). Operators can locate the row
// from the report even when an exporter uses arbitrary text for either ID.
export function shadowRowKey(projectId: string, row: OtelShadowRowLocator) {
  const startTime = shadowStoredTime(row.startTime);
  return {
    projectId,
    traceHash: xxh32(row.traceId),
    ...(startTime === undefined ? {} : { startTime }),
    ...(/^[a-f\d]{16}$/i.test(row.spanId) ? { spanId: row.spanId } : {}),
  };
}

// Queue-generated job IDs use UUIDv4. Exclude free-form job labels.
export function shadowJobId(id: string): string | undefined {
  return /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
    id,
  )
    ? id
    : undefined;
}
