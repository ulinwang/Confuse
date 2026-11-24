import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MediaAssociationOrigin } from "@prisma/client";
import { effectDifferences, otelShadowScope, ShadowScope } from "./context";
import { uploadOtelMedia } from "./media";

const identity = {
  projectId: "project-id",
  traceId: "trace-id",
  observationId: "observation-id",
  field: "input" as const,
  contentType: "image/png" as const,
  origin: MediaAssociationOrigin.INGESTION_MEDIA_EXTRACTION,
};

describe("shadow media boundary", () => {
  it("captures a primary result and replays it without loading or uploading", async () => {
    const sample = {};
    const primary = new ShadowScope("primary", sample);
    const native = new ShadowScope("native", sample);
    const body = Buffer.from("private media body");
    const digest = createHash("sha256").update(body).digest("base64");
    const loadBody = vi.fn().mockResolvedValue(body);
    const primaryUpload = vi.fn().mockResolvedValue({
      mediaId: "media-id",
      outcome: "uploaded" as const,
    });

    const primaryResult = await otelShadowScope.run(primary, () =>
      uploadOtelMedia({ ...identity, loadBody, upload: primaryUpload }),
    );

    expect(primaryResult).toEqual({
      mediaId: "media-id",
      outcome: "uploaded",
      byteLength: body.length,
    });
    expect(primaryUpload).toHaveBeenCalledWith(body, digest);

    const nativeLoadBody = vi.fn();
    const nativeUpload = vi.fn();
    const nativeResult = await otelShadowScope.run(native, () =>
      uploadOtelMedia({
        ...identity,
        sha256Hash: digest,
        loadBody: nativeLoadBody,
        upload: nativeUpload,
      }),
    );

    expect(nativeResult).toEqual(primaryResult);
    expect(nativeLoadBody).not.toHaveBeenCalled();
    expect(nativeUpload).not.toHaveBeenCalled();
    expect(effectDifferences(primary, native)).toEqual([]);
    expect(JSON.stringify([...primary.effects])).not.toContain(body.toString());
  });

  it("replays an upload failure so callers can keep the original value", async () => {
    const sample = {};
    const primary = new ShadowScope("primary", sample);
    const native = new ShadowScope("native", sample);
    const body = Buffer.from("failed media body");
    const digest = createHash("sha256").update(body).digest("base64");

    await expect(
      otelShadowScope.run(primary, () =>
        uploadOtelMedia({
          ...identity,
          loadBody: async () => body,
          upload: async () => {
            throw new Error("storage unavailable");
          },
        }),
      ),
    ).rejects.toThrow("storage unavailable");

    const nativeLoadBody = vi.fn();
    const nativeUpload = vi.fn();
    await expect(
      otelShadowScope.run(native, () =>
        uploadOtelMedia({
          ...identity,
          sha256Hash: digest,
          loadBody: nativeLoadBody,
          upload: nativeUpload,
        }),
      ),
    ).rejects.toThrow("replayed media upload failed");

    expect(nativeLoadBody).not.toHaveBeenCalled();
    expect(nativeUpload).not.toHaveBeenCalled();
    expect(effectDifferences(primary, native)).toEqual([]);
    expect(primary.failures).toEqual({ media_upload: 1 });
    expect(native.failures).toEqual({ media_upload: 1 });
  });
});
