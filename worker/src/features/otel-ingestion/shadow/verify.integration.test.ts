import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  primaryTable: "",
  shadowTable: "",
  queryCount: 0,
  queries: [] as Parameters<
    typeof import("@langfuse/shared/src/server").queryClickhouse
  >[0][],
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    queryClickhouse: async (
      options: Parameters<typeof actual.queryClickhouse>[0],
    ) => {
      route.queryCount++;
      route.queries.push(options);
      return actual.queryClickhouse({
        ...options,
        query: options.query
          .replaceAll("events_full", route.primaryTable)
          .replaceAll("events_native_test", route.shadowTable),
      });
    },
  };
});

import { clickhouseClient, logger } from "@langfuse/shared/src/server";
import {
  drainShadowRows,
  enqueueShadowRows,
  type OtelShadowRowSample,
  type OtelShadowRowDifference,
} from "./verify";

describe("deferred OTEL shadow verification against isolated ClickHouse tables", () => {
  const tables: string[] = [];
  let client: ReturnType<typeof clickhouseClient>;

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll("-", "");
    route.primaryTable = `otel_shadow_verify_primary_${suffix}`;
    route.shadowTable = `otel_shadow_verify_shadow_${suffix}`;
    tables.push(route.primaryTable, route.shadowTable);
    client = clickhouseClient();

    for (const table of tables) {
      await client.command({
        query: `CREATE TABLE ${table} AS events_full ENGINE = Memory`,
      });
    }
  });

  afterAll(async () => {
    for (const table of tables) {
      await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
    }
    await client.close();
  });

  it("matches rows, isolates deliveries, and reports safe changed fields", async () => {
    route.queryCount = 0;
    route.queries.length = 0;
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    const projectId = "project-1";
    const fileKey = "otel/project-1/delivery-1.json";
    const otherFileKey = "otel/project-1/other-delivery.json";
    const traceId = "trace-1";
    const startTime = "2026-11-24 10:00:00.123000";

    const locator = (spanId: string) => ({ traceId, spanId, startTime });
    const clockAt = (second: string) => ({
      created_at: `2026-11-24 10:00:${second}.000000`,
      updated_at: `2026-11-24 10:00:${second}.000000`,
      event_ts: `2026-11-24 10:00:${second}.000000`,
    });
    const row = (
      spanId: string,
      sourceFile: string,
      input: string,
      clocks = clockAt("01"),
    ) => ({
      project_id: projectId,
      trace_id: traceId,
      span_id: spanId,
      start_time: startTime,
      blob_storage_file_path: sourceFile,
      name: "shadow-test-span",
      provided_usage_details: {},
      usage_details: {},
      provided_cost_details: {},
      cost_details: {},
      tool_definitions: {},
      input,
      output: "same-output",
      event_bytes: input.length,
      ...clocks,
      is_deleted: 0,
    });

    const changedSpan = "000000000000001f";
    const equalPrimary = row("span-equal", fileKey, "same-payload");
    const equalShadow = row(
      "span-equal",
      fileKey,
      "same-payload",
      clockAt("02"),
    );
    const differentPrimary = row(changedSpan, fileKey, "primary-payload");
    const differentShadow = row(
      changedSpan,
      fileKey,
      "shadow-payload",
      clockAt("02"),
    );
    const duplicate = row("span-duplicate", fileKey, "duplicate-payload");

    await client.insert({
      table: route.primaryTable,
      format: "JSONEachRow",
      values: [
        equalPrimary,
        {
          ...row("map-order", fileKey, "same"),
          usage_details: { input: 11, output: 7 },
        },
        differentPrimary,
        row("span-missing-shadow", fileKey, "primary-only"),
        duplicate,
        duplicate,
        row("span-equal", otherFileKey, "other-delivery", clockAt("03")),
      ],
    });
    await client.insert({
      table: route.shadowTable,
      format: "JSONEachRow",
      values: [
        equalShadow,
        {
          ...row("map-order", fileKey, "same"),
          usage_details: { output: 7, input: 11 },
        },
        differentShadow,
        row("span-missing-primary", fileKey, "shadow-only", clockAt("02")),
        duplicate,
      ],
    });

    const samples: OtelShadowRowSample = {
      projectId,
      fileKey,
      jobId: "123e4567-e89b-42d3-a456-426614174000",
      inputBytes: 4_096,
      primary: [
        locator("span-equal"),
        locator("map-order"),
        locator(changedSpan),
        locator("span-missing-shadow"),
        locator("span-missing-both"),
        locator("span-duplicate"),
      ],
      shadow: [
        locator("span-equal"),
        locator("map-order"),
        locator(changedSpan),
        locator("span-missing-primary"),
        locator("span-duplicate"),
      ],
    };

    enqueueShadowRows(samples);
    await drainShadowRows();

    expect(route.queryCount).toBe(2);
    expect(route.queries[0].clickhouseSettings).toMatchObject({
      max_threads: 2,
      max_execution_time: 8,
      max_bytes_to_read: "536870912",
      max_result_rows: "14",
      result_overflow_mode: "throw",
    });
    const infoCall = info.mock.calls.find(
      ([message]) =>
        message ===
        "OTEL shadow persisted rows differ or could not be attributed",
    );
    const details = infoCall?.[1] as {
      counts: Record<string, number>;
      examples: OtelShadowRowDifference[];
    };
    expect(details.counts).toEqual({
      matched: 1,
      map_order_only: 1,
      different: 1,
      missing_primary: 1,
      missing_shadow: 1,
      missing_both: 1,
      ambiguous: 1,
    });
    expect(details.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "different",
          changedColumns: expect.arrayContaining([
            "event_bytes",
            "input",
            "unmapped_column",
          ]),
          jobId: samples.jobId,
        }),
        expect.objectContaining({
          outcome: "map_order_only",
          orderOnlyColumns: ["usage_details"],
        }),
        expect.objectContaining({
          outcome: "missing_shadow",
          primaryCopies: 1,
          shadowCopies: 0,
        }),
      ]),
    );
    for (const value of [
      fileKey,
      traceId,
      "span-missing-shadow",
      "primary-payload",
      "shadow-payload",
    ]) {
      expect(JSON.stringify(details.examples)).not.toContain(value);
    }
    expect(details.examples).toHaveLength(6);
    expect(
      details.examples.find(({ outcome }) => outcome === "different")?.rowKey,
    ).toMatchObject({
      projectId,
      startTime,
      spanId: changedSpan,
    });

    info.mockRestore();
  });
});
