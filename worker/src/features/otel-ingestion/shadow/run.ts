import { prepareOtelJson, type OtelProcessingContext } from "@langfuse/native";
import {
  logger,
  recordDistribution,
  recordIncrement,
  withCustomerDataLoggingSuppressed,
} from "@langfuse/shared/src/server";
import { getDeterministicSamplingValue } from "../../evaluation/deterministicSampling";
import { ClickhouseWriter } from "../../../services/ClickhouseWriter";
import { processRustOtelEvents } from "../processRustOtelEvents";
import { effectDifferences, ShadowScope } from "./context";
import { otelProcessingHooks } from "../processingHooks";
import { shadowJobId, shadowRowKey } from "./rowKey";
import { drainShadowRows, enqueueShadowRows } from "./verify";
import { closeShadowWriter } from "./writer";

const prefix = "langfuse.ingestion.otel.shadow.";
const pending = new Set<Promise<void>>();
const reservations = new Map<object, number>();
const maxInputBytes = 64 * 1024 * 1024;
const writerStages = {
  primary: "primary_writer",
  native: "shadow_writer",
} as const;

type Batch = {
  context: OtelProcessingContext;
  extractMedia: boolean;
  mediaPath: "reference" | "early";
  writeMode: "events_only" | "dual";
  jobId?: string;
};
type Sample = NonNullable<ReturnType<typeof reserveSample>>;

export function sampleFile(rate: number, projectId: string, fileKey: string) {
  return (
    rate > 0 &&
    (rate === 1 ||
      getDeterministicSamplingValue(
        JSON.stringify(["otel-native-shadow", projectId, fileKey]),
      ) < rate)
  );
}

export function reserveSample(
  source: Uint8Array | string | (() => string),
  batch: Batch,
) {
  const capacity = () => {
    recordIncrement(prefix + "batch", 1, { outcome: "capacity" });
    return undefined;
  };
  if (reservations.size >= 4) return capacity();

  try {
    const started = performance.now();
    const input = typeof source === "function" ? source() : source;
    const size =
      typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    const heldBytes = [...reservations.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
    if (size > maxInputBytes - heldBytes) return capacity();

    const bytes = Buffer.from(input);
    const token = {};
    reservations.set(token, size);
    return {
      ...batch,
      jobId: batch.jobId && shadowJobId(batch.jobId),
      bytes,
      started,
      primary: new ShadowScope("primary", token),
      release: () => reservations.delete(token),
    };
  } catch {
    recordIncrement(prefix + "batch", 1, { outcome: "input_error" });
  }
}

export type PrimaryStage =
  | "primary_parse"
  | "primary_convert"
  | "primary_process"
  | "primary_dispose";

export function submitSample(sample: Sample, failure?: PrimaryStage) {
  const task = otelProcessingHooks
    .exit(() => compare(sample, failure))
    .catch(() => {
      logger.warn("OTEL shadow comparison failed", {
        projectId: sample.context.projectId,
        jobId: sample.jobId,
      });
      recordIncrement(prefix + "batch", 1, { outcome: "error" });
    });
  pending.add(task);
  const cleanup = () => {
    sample.release();
    pending.delete(task);
  };
  task.then(cleanup, cleanup);
}

async function finish(scope: ShadowScope, started: number, failure?: string) {
  const processingMs = performance.now() - started;
  const receipt = await scope.settle();
  const stage =
    failure ?? (receipt === "dropped" ? writerStages[scope.side] : "none");
  return {
    outcome: failure ? ("exception" as const) : receipt,
    stage,
    processingMs,
    scope,
  };
}

async function compare(sample: Sample, failure?: PrimaryStage) {
  const primary = await finish(sample.primary, sample.started, failure);
  const native = await runNative(sample);
  report(sample, primary, native);
  enqueueShadowRows({
    projectId: sample.context.projectId,
    fileKey: sample.context.fileKey,
    jobId: sample.jobId,
    inputBytes: sample.bytes.length,
    primary: primary.scope.rows,
    shadow: native.scope.rows,
  });
}

async function runNative(sample: Sample) {
  const scope = new ShadowScope("native", sample.primary.sample);
  const started = performance.now();
  let stage: string | undefined = "shadow_prepare";
  await withCustomerDataLoggingSuppressed(() =>
    otelProcessingHooks.run(scope, async () => {
      try {
        const batch = await prepareOtelJson(sample.bytes, sample.extractMedia);
        stage = "shadow_process";
        try {
          await processRustOtelEvents({
            batch,
            context: { ...sample.context, suppressLogging: true },
          });
        } finally {
          await batch.dispose();
        }
        stage = undefined;
      } catch {
        // Keep customer payloads out of diagnostics; the stage is sufficient.
      }
    }),
  );
  return finish(scope, started, stage);
}

type Result = Awaited<ReturnType<typeof finish>>;

function classification(primary: Result, native: Result) {
  if (primary.stage !== "none")
    return native.stage !== "none" ? "both_failed" : "primary_only_failure";
  if (native.stage !== "none") return "shadow_only_failure";
  return primary.outcome === native.outcome ? "match" : "different_outcome";
}

function report(sample: Sample, primary: Result, native: Result) {
  const comparison = classification(primary, native);
  const tags = {
    comparison,
    primary_outcome: primary.outcome,
    shadow_outcome: native.outcome,
    primary_error_stage: primary.stage,
    shadow_error_stage: native.stage,
    write_mode: sample.writeMode,
    primary_media_path: sample.mediaPath,
    media_extraction: sample.extractMedia ? "enabled" : "disabled",
  };
  recordIncrement(prefix + "pair", 1, tags);

  for (const [implementation, result] of [
    ["ts", primary],
    ["rust", native],
  ] as const) {
    recordDistribution(
      prefix + "paired_processing_duration_ms",
      result.processingMs,
      { ...tags, implementation },
    );
  }

  const differences = effectDifferences(primary.scope);
  const primaryFailures = primary.scope.failures;
  const nativeFailures = native.scope.failures;
  const hasFailures =
    primary.stage !== "none" ||
    native.stage !== "none" ||
    Object.keys(primaryFailures).length > 0 ||
    Object.keys(nativeFailures).length > 0;
  if (differences.length === 0 && !hasFailures && comparison === "match")
    return;

  const rows =
    primary.scope.rows.length > 0 ? primary.scope.rows : native.scope.rows;
  logger.info("OTEL shadow batch differs or is incomplete", {
    ...tags,
    jobId: sample.jobId,
    projectId: sample.context.projectId,
    primaryInserted: primary.scope.rows.length,
    shadowInserted: native.scope.rows.length,
    differences,
    primaryFailures,
    nativeFailures,
    batchRowKeys: rows
      .slice(0, 3)
      .map((row) => shadowRowKey(sample.context.projectId, row)),
  });
}

export async function shutdownOtelWriters() {
  await ClickhouseWriter.shutdownAll();
  await Promise.all(pending);
  await closeShadowWriter();
  await drainShadowRows();
}
