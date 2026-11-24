import { expect, it } from "vitest";
import { effectDifferences, ShadowScope } from "./context";

it("waits for the last receipt after a split write and keeps the inserted row", async () => {
  const scope = new ShadowScope("primary", {});
  const row = { traceId: "t", spanId: "s", startTime: "2026-11-24T12:00:00Z" };
  const last = Promise.withResolvers<"inserted" | "dropped">();
  scope.observeWrite(row, (done) => done({ status: "inserted" }));
  scope.observeWrite(
    { ...row, spanId: "second" },
    (done) => void last.promise.then((status) => done({ status })),
  );
  expect(() =>
    scope.observeWrite(row, () => {
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
  expect(effectDifferences(primary)).toEqual([
    { kind: "upload", missing: 1, extra: 1 },
  ]);
});

it("replays repeated calls in start order and preserves a failed attempt", async () => {
  const primary = new ShadowScope("primary", {});
  const native = new ShadowScope("native", primary.sample);
  const slow = Promise.withResolvers<string>();
  const first = primary.effect("upload", "same", () => slow.promise);
  await primary.effect("upload", "same", async () => "second");
  await expect(
    primary.effect("upload", "same", async () => {
      throw new Error("private");
    }),
  ).rejects.toThrow("private");
  slow.resolve("first");
  await first;
  const replay = () =>
    native.effect<string>("upload", "same", () => {
      throw new Error("unexpected real upload");
    });
  expect(await replay()).toBe("first");
  expect(await replay()).toBe("second");
  await expect(replay()).rejects.toThrow("No successful primary result");
  expect(effectDifferences(primary)).toEqual([]);
});
