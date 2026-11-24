import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@langfuse/shared/src/server";

const mocks = vi.hoisted(() => ({
  queryClickhouse: vi.fn(),
  recordIncrement: vi.fn(),
  withCustomerDataLoggingSuppressed: vi.fn((callback: () => unknown) =>
    callback(),
  ),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langfuse/shared/src/server")>()),
  queryClickhouse: mocks.queryClickhouse,
  recordIncrement: mocks.recordIncrement,
  withCustomerDataLoggingSuppressed: mocks.withCustomerDataLoggingSuppressed,
}));

import {
  drainShadowRows,
  enqueueShadowRows,
  type OtelShadowRowSample,
} from "./verify";

const metric = "langfuse.ingestion.otel.shadow.row_verification";
const locator = (spanId: string, traceId = "trace-1") => ({
  traceId,
  spanId,
  startTime: "2026-11-24 10:00:00.000000",
});
const sample = (
  overrides: Partial<OtelShadowRowSample> = {},
): OtelShadowRowSample => ({
  projectId: "project-1",
  fileKey: "otel/project-1/delivery-1.json",
  inputBytes: 128,
  primary: [locator("span-1")],
  shadow: [locator("span-1")],
  ...overrides,
});

describe("deferred OTEL shadow row verification", () => {
  beforeEach(() => {
    mocks.queryClickhouse.mockReset();
    mocks.queryClickhouse.mockResolvedValue([]);
    mocks.recordIncrement.mockReset();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await drainShadowRows();
    vi.restoreAllMocks();
  });

  it("limits reads to 64 locators and continues after one chunk fails", async () => {
    const keys = Array.from({ length: 65 }, (_, index) =>
      locator(String(index)),
    );
    mocks.queryClickhouse.mockRejectedValueOnce(new Error("read failure"));
    enqueueShadowRows(sample({ primary: keys, shadow: keys.slice(0, 1) }));
    enqueueShadowRows(sample({ primary: [], shadow: keys.slice(1) }));
    await drainShadowRows();

    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(2);
    expect(mocks.recordIncrement).toHaveBeenCalledWith(metric, 64, {
      outcome: "read_error",
    });
    expect(mocks.recordIncrement).toHaveBeenCalledWith(metric, 1, {
      outcome: "ambiguous",
    });
  });

  it("delays sparse traffic, but flushes a settled 64 MiB crossing", async () => {
    vi.useFakeTimers();
    enqueueShadowRows(sample());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.queryClickhouse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1);

    enqueueShadowRows(
      sample({ fileKey: "first", inputBytes: 32 * 1024 * 1024 }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    enqueueShadowRows(
      sample({ fileKey: "second", inputBytes: 32 * 1024 * 1024 }),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(2);
    expect(mocks.queryClickhouse.mock.calls[1][0].params.locators).toHaveLength(
      2,
    );
  });

  it("counts active rows against the retention cap", async () => {
    let release: (() => void) | undefined;
    mocks.queryClickhouse.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );
    enqueueShadowRows(
      sample({
        primary: Array.from({ length: 16_384 }, (_, index) =>
          locator("span-" + index),
        ),
        shadow: [],
      }),
    );
    const draining = drainShadowRows();
    await vi.waitFor(() =>
      expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1),
    );
    enqueueShadowRows(sample());
    expect(mocks.recordIncrement).toHaveBeenCalledWith(metric, 2, {
      outcome: "capacity",
    });
    release?.();
    await draining;
  });

  it("keeps the PK prefix, limits, and error privacy in one query contract", async () => {
    const canary = "private-source-file";
    const warn = vi.spyOn(logger, "warn");
    mocks.queryClickhouse.mockRejectedValueOnce(
      Object.assign(new Error(canary), { name: canary, code: canary }),
    );
    enqueueShadowRows(sample({ fileKey: canary }));
    await drainShadowRows();

    const options = mocks.queryClickhouse.mock.calls[0][0];
    expect(options.clickhouseSettings).toMatchObject({
      max_threads: 2,
      max_execution_time: 8,
      max_bytes_to_read: "536870912",
      max_result_rows: "2",
      result_overflow_mode: "throw",
      log_queries: 0,
    });
    expect(options.query).toContain("toStartOfMinute(e.start_time)");
    expect(options.query).toContain("xxHash32(e.trace_id)");
    expect(options.query).toContain("e.blob_storage_file_path");
    expect(options.query).not.toContain("FINAL");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "OTEL shadow persisted-row verification query failed",
      { batches: 1 },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });
});
