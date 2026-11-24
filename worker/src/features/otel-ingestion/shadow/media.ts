import { createHash } from "node:crypto";
import {
  stableJsonStringify,
  type MediaContentType,
  type MediaField,
} from "@langfuse/shared";
import type { MediaAssociationOrigin } from "@prisma/client";
import { otelShadowScope } from "./context";

export type ShadowMediaUploadResult = {
  mediaId: string;
  outcome: "uploaded" | "reused";
  byteLength: number;
};

export type ShadowMediaUploadIdentity = {
  projectId: string;
  traceId: string;
  observationId?: string;
  field: MediaField;
  contentType: MediaContentType | string;
  origin: MediaAssociationOrigin;
  sha256Hash?: string;
};

type ShadowMediaAttempt =
  | { result: ShadowMediaUploadResult }
  | { failed: true };

type ShadowMediaSample = {
  attempts: Map<string, ShadowMediaAttempt[]>;
  consumed: Map<string, number>;
};

type ShadowScope = NonNullable<ReturnType<typeof otelShadowScope.getStore>>;

const mediaSamples = new WeakMap<object, ShadowMediaSample>();
// Field-overflow uploads use this same stage: overflow is a media upload
// operation, while the identity still keeps its field and origin distinct.
const MEDIA_FAILURE_STAGE = "media_upload";

/** Keep the production boundary intact while native shadow work only replays. */
export async function uploadOtelMedia(
  params: ShadowMediaUploadIdentity & {
    loadBody: () => Promise<Buffer>;
    upload: (
      contentBytes: Buffer,
      sha256Hash?: string,
    ) => Promise<Pick<ShadowMediaUploadResult, "mediaId" | "outcome">>;
  },
): Promise<ShadowMediaUploadResult> {
  const scope = otelShadowScope.getStore();
  if (scope?.side === "native") {
    return replayOtelMediaResult(params);
  }

  let sha256Hash = params.sha256Hash;
  try {
    const contentBytes = await params.loadBody();
    if (scope && !sha256Hash) {
      sha256Hash = createHash("sha256").update(contentBytes).digest("base64");
    }
    const result = {
      ...(await params.upload(contentBytes, sha256Hash)),
      byteLength: contentBytes.length,
    };
    if (scope && sha256Hash) record(scope, params, sha256Hash, result);
    return result;
  } catch (error) {
    if (scope && sha256Hash) {
      record(scope, params, sha256Hash, undefined);
      scope.fail(MEDIA_FAILURE_STAGE);
    } else if (scope) scope.fail("media_capture");
    throw error;
  }
}

/** Record a cache-hit occurrence, or consume its primary result in native. */
export function recordOtelMediaResult(
  identity: ShadowMediaUploadIdentity & { sha256Hash: string },
  result: ShadowMediaUploadResult,
): ShadowMediaUploadResult {
  const scope = otelShadowScope.getStore();
  if (!scope) return result;
  if (scope.side === "native") return replayOtelMediaResult(identity);
  record(scope, identity, identity.sha256Hash, result);
  return result;
}

export function replayOtelMediaResult(
  identity: ShadowMediaUploadIdentity,
): ShadowMediaUploadResult {
  const scope = otelShadowScope.getStore();
  if (scope?.side !== "native") {
    throw new Error("Native OTEL media replay requires a native shadow scope");
  }
  if (!identity.sha256Hash) {
    scope.fail("media_identity");
    throw new Error("Native OTEL media replay is missing its digest");
  }
  return replay(scope, identity, identity.sha256Hash);
}

function record(
  scope: ShadowScope,
  params: ShadowMediaUploadIdentity,
  sha256Hash: string,
  result: ShadowMediaUploadResult | undefined,
): void {
  const { key, identity } = getMediaIdentity(params, sha256Hash);
  const attempts = mediaSamples.get(scope.sample) ?? {
    attempts: new Map<string, ShadowMediaAttempt[]>(),
    consumed: new Map<string, number>(),
  };
  const values = attempts.attempts.get(key) ?? [];
  values.push(result ? { result } : { failed: true });
  attempts.attempts.set(key, values);
  mediaSamples.set(scope.sample, attempts);
  scope.record("media", identity);
}

function replay(
  scope: ShadowScope,
  params: ShadowMediaUploadIdentity,
  sha256Hash: string,
): ShadowMediaUploadResult {
  const { key, identity } = getMediaIdentity(params, sha256Hash);
  const state = mediaSamples.get(scope.sample);
  const values = state?.attempts.get(key);
  const index = state?.consumed.get(key) ?? 0;
  const attempt = values?.[index];
  if (state) state.consumed.set(key, index + 1);
  scope.record("media", identity);
  if (!attempt) {
    scope.fail("media_replay");
    throw new Error("No primary OTEL media upload result to replay");
  }
  if ("failed" in attempt) {
    scope.fail(MEDIA_FAILURE_STAGE);
    throw new Error("replayed media upload failed");
  }
  return attempt.result;
}

function getMediaIdentity(
  params: ShadowMediaUploadIdentity,
  sha256Hash: string,
): { key: string; identity: readonly unknown[] } {
  const identity = [
    params.projectId,
    params.traceId,
    params.observationId ?? null,
    params.field,
    params.contentType,
    params.origin,
    sha256Hash,
  ] as const;
  return { key: stableJsonStringify(identity), identity };
}
