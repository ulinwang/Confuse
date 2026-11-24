import { AsyncLocalStorage } from "node:async_hooks";
import type { findModel, redis } from "@langfuse/shared/src/server";
import type { ClickhouseWriter } from "../../services/ClickhouseWriter";
import type { OtelMediaHooks } from "../otel-media/uploadHooks";
import type { OtelSchedulingHooks } from "./scheduling";

type RowKey = { traceId: string; spanId: string; startTime: string };
type Receipt = { status: "inserted" | "dropped" };

export type OtelProcessingHooks = {
  media?: OtelMediaHooks;
  scheduling?: OtelSchedulingHooks;
  onFailure?: (stage: string) => void;
  recordIngestionMetrics?: boolean;
  lookups?: { redis: typeof redis; findModel: typeof findModel };
  getNativeWriter?: typeof ClickhouseWriter.getNativeInstance;
  observeWrite?: (
    row: RowKey,
    enqueue: (terminal: (receipt: Receipt) => void) => void,
  ) => void;
};

/** Overrides apply to a single direct ingestion call and its asynchronous I/O. */
export const otelProcessingHooks = new AsyncLocalStorage<
  OtelProcessingHooks | undefined
>();
