import { createHash } from "node:crypto";
import type { ShadowScope } from "./context";
import type {
  OtelMediaHooks,
  OtelMediaUploadRequest,
} from "../../otel-media/uploadHooks";

type MediaIdentity = Pick<
  OtelMediaUploadRequest,
  "projectId" | "traceId" | "observationId" | "field" | "contentType" | "origin"
>;

const mediaIdentity = (request: MediaIdentity, sha256Hash: string) =>
  [
    request.projectId,
    request.traceId,
    request.observationId ?? null,
    request.field,
    request.contentType,
    request.origin,
    sha256Hash,
  ] as const;

export function mediaHooks(scope: ShadowScope): OtelMediaHooks {
  return {
    upload: (request, primary) => {
      const sha256Hash = request.sha256Hash;
      if (sha256Hash) {
        const identity = mediaIdentity(request, sha256Hash);
        return scope.effect("media", identity, () => primary(request));
      }

      if (scope.side === "native") {
        scope.fail("media_identity");
        throw new Error("Native OTEL media replay is missing its digest");
      }

      const loadAndEffect = async () => {
        const contentBytes = await request.loadBody().catch((error) => {
          scope.fail("media_identity");
          throw error;
        });
        const derivedHash = createHash("sha256")
          .update(contentBytes)
          .digest("base64");
        return scope.effect("media", mediaIdentity(request, derivedHash), () =>
          primary({
            ...request,
            sha256Hash: derivedHash,
            loadBody: async () => contentBytes,
            admit: undefined,
          }),
        );
      };
      return request.admit?.(loadAndEffect) ?? loadAndEffect();
    },
    associate: (request, primary) =>
      scope.effect(
        "media",
        mediaIdentity(request.identity, request.identity.sha256Hash),
        primary,
      ),
  };
}
