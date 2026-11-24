import { describe, expect, it } from "vitest";

import { shadowJobId, shadowRowKey, shadowStoredTime } from "./rowKey";

describe("OTEL shadow diagnostic keys", () => {
  it("normalizes writer timestamps without retaining raw identifiers", () => {
    expect(shadowStoredTime("2026-11-24T10:00:00.123456789Z")).toBe(
      "2026-11-24 10:00:00.123456",
    );
    expect(
      shadowRowKey("project-1", {
        traceId: "customer-trace-id",
        spanId: "000000000000001f",
        startTime: "2026-11-24T10:00:00.123456789Z",
      }),
    ).toEqual({
      projectId: "project-1",
      traceHash: expect.any(Number),
      startTime: "2026-11-24 10:00:00.123456",
      spanId: "000000000000001f",
    });
  });

  it("only exposes server-minted UUIDv4 job identifiers", () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    expect(shadowJobId(jobId)).toBe(jobId);
    expect(shadowJobId("private-job-id")).toBeUndefined();
  });
});
