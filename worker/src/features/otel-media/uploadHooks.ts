import {
  MediaAssociationOrigin,
  type MediaContentType,
  type MediaField,
} from "@langfuse/shared";
import { otelProcessingHooks } from "../otel-ingestion/processingHooks";

type OtelMediaUploadIdentity = {
  projectId: string;
  traceId: string;
  observationId?: string;
  field: MediaField;
  contentType: MediaContentType | string;
  origin: MediaAssociationOrigin;
  sha256Hash?: string;
};

export type OtelMediaUploadResult = {
  mediaId: string;
  outcome: "uploaded" | "reused";
  byteLength: number;
};

export type OtelMediaUploadRequest = OtelMediaUploadIdentity & {
  loadBody: () => Promise<Buffer>;
  upload: (
    contentBytes: Buffer,
    sha256Hash?: string,
  ) => Promise<Pick<OtelMediaUploadResult, "mediaId" | "outcome">>;
  admit?: <T>(work: () => Promise<T>) => Promise<T>;
};

export type OtelMediaAssociationRequest = {
  identity: OtelMediaUploadIdentity & { sha256Hash: string };
  result: OtelMediaUploadResult;
  associate: () => Promise<void>;
};

export type OtelMediaHooks = {
  upload?: (
    request: OtelMediaUploadRequest,
    primary: (
      request: OtelMediaUploadRequest,
    ) => Promise<OtelMediaUploadResult>,
  ) => Promise<OtelMediaUploadResult>;
  associate?: (
    request: OtelMediaAssociationRequest,
    primary: () => Promise<OtelMediaUploadResult>,
  ) => Promise<OtelMediaUploadResult>;
};

export function shouldRecordOtelMediaMetrics(): boolean {
  return otelProcessingHooks.getStore()?.recordIngestionMetrics !== false;
}

async function uploadMedia(
  request: OtelMediaUploadRequest,
): Promise<OtelMediaUploadResult> {
  const performUpload = async () => {
    const contentBytes = await request.loadBody();
    return {
      ...(await request.upload(contentBytes, request.sha256Hash)),
      byteLength: contentBytes.length,
    };
  };
  return request.admit ? request.admit(performUpload) : performUpload();
}

export async function uploadOtelMedia(
  request: OtelMediaUploadRequest,
): Promise<OtelMediaUploadResult> {
  const processingHooks = otelProcessingHooks.getStore();
  const primary = processingHooks?.media?.upload;
  if (primary) return primary(request, uploadMedia);

  try {
    return await uploadMedia(request);
  } catch (error) {
    processingHooks?.onFailure?.("media_upload");
    throw error;
  }
}

export async function associateOtelMedia(
  request: OtelMediaAssociationRequest,
): Promise<OtelMediaUploadResult> {
  const processingHooks = otelProcessingHooks.getStore();
  const primary = async () => {
    await request.associate();
    return request.result;
  };
  const associate = processingHooks?.media?.associate;
  if (associate) return associate(request, primary);

  try {
    return await primary();
  } catch (error) {
    processingHooks?.onFailure?.("media_association");
    throw error;
  }
}
