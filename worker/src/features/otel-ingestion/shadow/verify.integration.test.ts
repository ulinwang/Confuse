import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  primaryTable: "",
  shadowTable: "",
  queryCount: 0,
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

  it("covers each persisted-row outcome and delivery isolation", async () => {
    route.queryCount = 0;
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const projectId = "project-1";
    const fileKey = "otel/project-1/delivery-1.json";
    const traceId = "trace-1";
    const startTime = "2026-11-24 10:00:00.123000";
    const changedSpan = "000000000000001f";
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const locator = (spanId: string) => ({ traceId, spanId, startTime });
    const row = (span_id: string, input = "same") => ({
      project_id: projectId,
      trace_id: traceId,
      start_time: startTime,
      blob_storage_file_path: fileKey,
      span_id,
      input,
      event_bytes: input.length,
    });
    const common = row("matched");
    const ordered = row("map-order");
    const duplicate = row("duplicate");
    await client.insert({
      table: route.primaryTable,
      format: "JSONEachRow",
      values: [
        common,
        duplicate,
        duplicate,
        row(changedSpan, "primary-payload"),
        row("missing-shadow"),
        { ...ordered, usage_details: { input: 11, output: 7 } },
        { ...row("file-isolated"), blob_storage_file_path: "other-delivery" },
      ],
    });
    await client.insert({
      table: route.shadowTable,
      format: "JSONEachRow",
      values: [
        { ...common, event_ts: "2025-01-01 12:00:00" },
        duplicate,
        row(changedSpan, "shadow-payload"),
        row("missing-primary"),
        { ...ordered, usage_details: { output: 7, input: 11 } },
      ],
    });
    const both = [
      "matched",
      "duplicate",
      changedSpan,
      "map-order",
      "missing-both",
      "file-isolated",
    ];
    enqueueShadowRows({
      projectId,
      fileKey,
      jobId,
      inputBytes: 4096,
      primary: [...both, "missing-shadow"].map(locator),
      shadow: [...both, "missing-primary"].map(locator),
    });
    await drainShadowRows();

    expect(route.queryCount).toBe(1);
    const details = info.mock.calls.at(-1)?.[1] as {
      counts: Record<string, number>;
      examples: OtelShadowRowDifference[];
    };
    expect(details.counts).toEqual({
      matched: 1,
      map_order_only: 1,
      different: 1,
      missing_primary: 1,
      missing_shadow: 1,
      missing_both: 2,
      ambiguous: 1,
    });
    expect(details.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "different",
          changedColumns: ["event_bytes", "input", "input_length"],
          jobId,
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
    expect(details.examples).toHaveLength(6);
    for (const value of [
      fileKey,
      traceId,
      "missing-shadow",
      "primary-payload",
      "shadow-payload",
    ]) {
      expect(JSON.stringify(details.examples)).not.toContain(value);
    }
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
