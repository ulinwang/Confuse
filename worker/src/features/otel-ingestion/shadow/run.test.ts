import { expect, it } from "vitest";
import { reserveSample, sampleFile } from "./run";

it("keeps the same files when retrying and increasing the sampling rate", () => {
  const files = Array.from({ length: 4096 }, (_, i) => String(i));
  const selected = (rate: number) =>
    files.filter((file) => sampleFile(rate, "project", file));
  const small = selected(0.001);
  expect(small.length).toBeGreaterThan(0);
  expect(selected(0)).toEqual([]);
  expect(selected(0.001)).toEqual(small);
  expect(selected(0.01)).toEqual(expect.arrayContaining(small));
});

it("skips masking snapshots while all sample slots are held", () => {
  const batch = {
    context: {
      projectId: "p",
      fileKey: "f",
      now: "2026-11-24T00:00:00Z",
      isLangfuseInternal: false,
      ingestionApiKey: "",
      ingestionSdkName: "test",
      ingestionSdkVersion: "1",
    },
    extractMedia: false,
    mediaPath: "reference",
    writeMode: "events_only",
  } as const;
  const held = Array.from({ length: 4 }, () => reserveSample("[]", batch));
  let snapshots = 0;
  const snapshot = () => {
    snapshots++;
    return "[]";
  };
  try {
    expect(held.every(Boolean)).toBe(true);
    expect(reserveSample(snapshot, batch)).toBeUndefined();
    expect(snapshots).toBe(0);
    held[0]?.release();
    held[0]?.release();
    const next = reserveSample(snapshot, batch);
    try {
      expect(next).toBeDefined();
      expect(reserveSample(snapshot, batch)).toBeUndefined();
      expect(snapshots).toBe(1);
    } finally {
      next?.release();
    }
  } finally {
    for (const sample of held) sample?.release();
  }
});
