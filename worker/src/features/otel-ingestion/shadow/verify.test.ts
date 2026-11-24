import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@langfuse/shared/src/server";

const mocks = vi.hoisted(() => ({
  queryClickhouse: vi.fn(),
  recordIncrement: vi.fn(),
  withCustomerDataLoggingSuppressed: vi.fn((callback: () => unknown) =>
    callback(),
  ),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    queryClickhouse: mocks.queryClickhouse,
    recordIncrement: mocks.recordIncrement,
    withCustomerDataLoggingSuppressed: mocks.withCustomerDataLoggingSuppressed,
  };
});

import {
  drainShadowRows,
  enqueueShadowRows,
  type OtelShadowRowSample,
} from "./verify";

const verificationMetric = "langfuse.ingestion.otel.shadow.row_verification";

const locator = (
  spanId: string,
  startTime = "2026-11-24 10:00:00.000000",
  traceId = "trace-1",
) => ({
  traceId,
  spanId,
  startTime,
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

  it("chunks 513 keys into two reads instead of one read per key", async () => {
    const keys = Array.from({ length: 513 }, (_, index) =>
      locator(String(index)),
    );
    enqueueShadowRows(sample({ primary: keys, shadow: keys.slice(0, 1) }));
    enqueueShadowRows(sample({ primary: [], shadow: keys.slice(1) }));

    await drainShadowRows();

    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(2);
    expect(mocks.recordIncrement).toHaveBeenCalledWith(verificationMetric, 1, {
      outcome: "missing_both",
    });
    expect(mocks.recordIncrement).toHaveBeenCalledWith(
      verificationMetric,
      512,
      { outcome: "ambiguous" },
    );
  });

  it("keeps low traffic until the 30-second max age", async () => {
    vi.useFakeTimers();

    enqueueShadowRows(sample());
    expect(mocks.queryClickhouse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.queryClickhouse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1);
  });

  it("waits for the sample crossing 64 MiB to settle", async () => {
    vi.useFakeTimers();

    enqueueShadowRows(sample({ inputBytes: 32 * 1024 * 1024 }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.queryClickhouse).not.toHaveBeenCalled();

    enqueueShadowRows(
      sample({ fileKey: "next-file", inputBytes: 32 * 1024 * 1024 }),
    );
    await vi.advanceTimersByTimeAsync(8_999);
    expect(mocks.queryClickhouse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1);
    expect(mocks.queryClickhouse.mock.calls[0][0].params.locators).toHaveLength(
      2,
    );
  });

  it("counts rows in an active read against the retention cap", async () => {
    let release: (() => void) | undefined;
    mocks.queryClickhouse.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    enqueueShadowRows(
      sample({
        primary: Array.from({ length: 16_384 }, (_, index) =>
          locator(`span-${index}`),
        ),
        shadow: [],
      }),
    );

    const draining = drainShadowRows();
    await vi.waitFor(() =>
      expect(mocks.queryClickhouse).toHaveBeenCalledTimes(1),
    );
    enqueueShadowRows(sample());
    expect(mocks.recordIncrement).toHaveBeenCalledWith(verificationMetric, 2, {
      outcome: "capacity",
    });

    release?.();
    await draining;
  });

  it("keeps query limits and the primary-key prefix in the SQL", async () => {
    enqueueShadowRows(sample());
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
  });

  it("does not copy a failed query error into the warning", async () => {
    const canary = "private-source-file";
    const warn = vi.spyOn(logger, "warn");
    mocks.queryClickhouse.mockRejectedValueOnce(
      Object.assign(new Error(canary), { name: canary, code: canary }),
    );
    enqueueShadowRows(sample({ fileKey: canary }));

    await drainShadowRows();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "OTEL shadow persisted-row verification query failed",
      { batches: 1 },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });
});
