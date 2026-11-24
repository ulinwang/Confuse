import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MediaAssociationOrigin } from "@langfuse/shared";
import { effectDifferences, ShadowScope } from "./context";
import { otelProcessingHooks } from "../processingHooks";
import { uploadOtelMedia } from "../../otel-media/uploadHooks";

const identity = {
  projectId: "project-id",
  traceId: "trace-id",
  observationId: "observation-id",
  field: "input" as const,
  contentType: "image/png" as const,
  origin: MediaAssociationOrigin.INGESTION_MEDIA_EXTRACTION,
};

it.each([true, false])(
  "replays the primary upload outcome (success=%s) without reading the native body",
  async (success) => {
    const primary = new ShadowScope("primary", {});
    const native = new ShadowScope("native", primary.sample);
    const body = Buffer.from("private media body");
    const digest = createHash("sha256").update(body).digest("base64");
    const upload = vi.fn(async () => {
      if (!success) throw new Error("storage unavailable");
      return { mediaId: "media-id", outcome: "uploaded" as const };
    });
    const actual = otelProcessingHooks.run(primary, () =>
      uploadOtelMedia({ ...identity, loadBody: async () => body, upload }),
    );
    if (success)
      await expect(actual).resolves.toMatchObject({ byteLength: body.length });
    else await expect(actual).rejects.toThrow("storage unavailable");
    expect(upload).toHaveBeenCalledWith(body, digest);

    const loadBody = vi.fn();
    const replay = otelProcessingHooks.run(native, () =>
      uploadOtelMedia({ ...identity, sha256Hash: digest, loadBody, upload }),
    );
    if (success) await expect(replay).resolves.toEqual(await actual);
    else await expect(replay).rejects.toThrow("No successful primary result");
    expect(loadBody).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(effectDifferences(primary)).toEqual([]);
    expect(native.failures).toEqual(success ? {} : { media: 1 });
  },
);
