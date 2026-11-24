# OTEL replay tests

Run the OTEL replay suites against an isolated ClickHouse table:

```sh
pnpm --filter worker run build
pnpm --filter worker run test:otel-replay
```

Use local or disposable test services: migrated ClickHouse and Postgres databases
and Redis without active ingestion consumers. The
test client uses `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, and
`CLICKHOUSE_DB`; Vitest loads the repository's `.env` without overriding supplied
environment variables. The configured user needs to read the `events_full`
schema and create, insert into, select from, and drop the test tables. An
unavailable ClickHouse server fails the run.

## What a replay checks

1. Run the same stored JSON through original TypeScript, TypeScript with early
   media extraction, and Rust with early media extraction. The Rust
   path also normalizes and enriches spans and detects remaining media.
2. Let each production writer encode and send its insert. The test client
   redirects, for example, an `events_full` insert to a fresh table with the
   same columns and defaults. An insert into an unexpected table fails the test.
3. Flush the writers and compare the rows ClickHouse stored. In dual-write
   tests, the harness also processes its own legacy jobs and checks the trace
   and observation tables. It removes those jobs even if processing fails.

The test tables use the Memory engine. They exercise serialization, column types,
and defaults. MergeTree deduplication and materialized views need separate coverage.
Generated cases have reproducible seeds. The harness disables retries, blob-storage
file logging, and background trace evaluation jobs.

## Scope and caveats

- Scratch tables isolate ClickHouse inserts and provide predictable readback
  targets. They do not isolate the whole application from production services.
  Dual tests create Postgres project/session state and real Redis jobs; run them
  only against test services. Another worker consuming those jobs would race the
  harness.
- Each replay processes one document under the direct-v4 route, with optional
  legacy writes. The job explicitly selects ingestion version 4; an empty
  staging table does not test the queue-forwarded events route.
- Legacy merge reads still target ordinary trace and observation tables. Dual
  cases use fresh projects with no existing rows. They do not cover updates
  across replay calls: a later call cannot read the earlier scratch writes.
  Such tests need reads and writes to share the same isolated state first.
- The harness invokes production queue processors in-process, including the
  legacy jobs it enqueues. It does not exercise BullMQ worker consumption,
  Redis deserialization, scheduling, or retries.
- Media uploads and association writes use test doubles. Their calls can verify
  content and destinations, but do not prove object-storage persistence or
  Postgres media/link persistence. Model/prompt lookups and evaluation services
  are also controlled rather than end-to-end.

The current corpus is synthetic. Production S3 capture is a separate extension:
preserve the raw object bytes, then replay against local services with an
explicit routing/configuration context. Running from a bastion is compatible
with that model, but pointing this test command at production databases or
queues is not.

## Persisted event size

`events_full.event_bytes` uses ClickHouse's `byteSize(...)` estimate of input, output, metadata, trace/span/user/session identifiers, names and status text after media extraction and overflow. Internal bookkeeping, derived values and copied experiment metadata are excluded. This measures typed, uncompressed customer payload rather than JSON length or disk usage. Core and billing projections retain the untruncated payload estimate. Keep the formula stable across small schema additions; include new large customer payload fields through a later migration.

At startup, TypeScript writers detect the sizing DEFAULT with `DESCRIBE TABLE events_full`. If confirmed, direct and staging writes omit `event_bytes`; otherwise they keep their legacy estimates. Detection failures warn and continue. The mode stays fixed until restart. Native blocks always omit the column and require the migration first. Older writers may still supply explicit sizes. Historical rows and backfill accounting are unchanged. Restore older writers before rolling back the database default.

Raw ingress limits and byte-length telemetry remain pre-media measurements. Trace dispatch intake estimates read capacity separately for sampled spans. See [trace-window size estimates](../traceDispatch/README.md#trace-window-size-estimates).

## Rust direct processing

`LANGFUSE_OTEL_DIRECT_IMPLEMENTATION=rust` selects Rust for direct events-table writes in projects admitted by the early-media selector. It requires early extraction; media uploads remain optional. Unselected projects keep the original TypeScript path. Legacy writes remain in TypeScript in dual-write mode; events-only Rust jobs skip constructing the TypeScript span graph. The Rust path retains the native media registry through normalization and service calls.

Native errors reject the job without falling back to TypeScript processing.

## Comparing TypeScript and Rust ingestion

With TypeScript as the direct writer, set `LANGFUSE_OTEL_NATIVE_SHADOW_SAMPLE_RATE` to compare a stable sample by project and source file. The default is `0` and works with only production tables. Rates of `0.001`, `0.01`, and `0.05` select approximately 0.1%, 1%, and 5% of batches. Raising the rate retains the earlier cohort.

Before enabling sampling, provision `events_native_test` with the same schema, defaults and sorting key as `events_full`. On an unreplicated development database use `CREATE TABLE events_native_test AS events_full`. On replicated deployments give the test table its own replication path and retention policy. Keep production materialized views attached only to `events_full`.

The worker keeps up to four accepted inputs totaling 64 MiB. After the primary writer acknowledges or drops its rows, the worker runs the production Rust processor on the same masked bytes. An empty result or an exception after input acceptance also triggers a comparison when the direct route is known. A masking rejection, capacity limit, or worker crash can leave a batch without a comparison. Production queue retries follow the TypeScript outcome.

### Reading a comparison

All metrics below use the prefix `langfuse.ingestion.otel.shadow.`.

- Group `pair` by `comparison`, `primary_outcome`, and `shadow_outcome` to find one-sided failures. The stage tags distinguish preparation, processing and write failures. `operation_failure` also counts failures handled inside either processor. Rust can share a failed lookup across several spans. Use the inserted counts and row verification to see how many rows were affected.
- `effect_difference` counts extra and missing requests by kind. Rust reuses the primary media and overflow upload results. Both sides run the evaluation scheduler with the same rules. A failed primary request still counts as attempted. Filter on `coverage:complete` to exclude comparisons affected by a failure or missing rules. Trace dispatch compares trace ID, span time and rule IDs. Each path uses its own byte estimate.
- `row_verification` counts stored matches, changed values, map-order differences and ambiguous or missing rows. The verifier groups reads by 64 MiB of sampled input or roughly 30 seconds on quieter workers. It includes ClickHouse defaults and derived columns and skips the three write-time clocks. A detail query identifies changed columns for one example per mismatch type. Reports contain keys, counts and column names.
- Compare `paired_processing_duration_ms` by implementation within successful, events-only batches with the same `primary_media_path`. A `processing_rust_to_ts_ratio` of 0.8 means Rust took 80% as long. `paired_writer_wait_duration_ms` measures buffered insert delays separately. TypeScript performs the real upload and scheduling I/O. Rust performs uncached read-only enrichment lookups. A dual-write primary also includes legacy work. These timings describe the sampled rollout workload.

Use a reported key in an authorized ClickHouse session to locate the original file. Query the side that stored the row and omit the span predicate if the example has no span ID. Multiple deliveries can return several file paths.

```sql
SELECT DISTINCT blob_storage_file_path
FROM events_full
WHERE project_id = {projectId:String}
  AND toStartOfMinute(start_time) = toStartOfMinute({startTime:DateTime64(6, 'UTC')})
  AND xxHash32(trace_id) = {traceHash:UInt32}
  AND span_id = {spanId:String}
  AND start_time = {startTime:DateTime64(6, 'UTC')}
```
