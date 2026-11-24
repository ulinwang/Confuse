import { expect, it } from "vitest";
import { effectDifferences, ShadowScope } from "./context";

it("waits for the last receipt after a split write and keeps the inserted row", async () => {
  const scope = new ShadowScope("primary", {});
  const row = { traceId: "t", spanId: "s", startTime: "2026-11-24T12:00:00Z" };
  const last = Promise.withResolvers<"inserted" | "dropped">();
  scope.track(row, (done) => done({ status: "inserted" }));
  scope.track(
    { ...row, spanId: "second" },
    (done) => void last.promise.then((status) => done({ status })),
  );
  expect(() =>
    scope.track(row, () => {
      throw new Error("writer unavailable");
    }),
  ).toThrow();
  const outcome = scope.settle();
  expect(scope.rows).toEqual([row]);
  last.resolve("dropped");
  await expect(outcome).resolves.toBe("dropped");
});

it("compares repeated operations regardless of execution order", () => {
  const primary = new ShadowScope("primary", {});
  const native = new ShadowScope("native", primary.sample);
  for (const request of ["a", "b", "a"]) primary.record("upload", request);
  for (const request of ["b", "a", "c"]) native.record("upload", request);
  expect(effectDifferences(primary, native)).toEqual([
    { kind: "upload", missing: 1, extra: 1 },
  ]);
});
