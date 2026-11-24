import { beforeEach, expect, it, vi } from "vitest";
import type { EvalRules } from "../../evaluation/fetchEvalRules";
import type { EvalSchedulerDeps } from "../../evaluation/scheduleEvals";
import { effectDifferences, otelShadowScope, ShadowScope } from "./context";
import {
  createOtelShadowEvalSchedulerDeps,
  getOtelShadowScheduling,
} from "./eval";

const mocks = vi.hoisted(() => ({
  createEvalSchedulerDeps: vi.fn(),
}));

vi.mock("../../evaluation/scheduleEvals", () => ({
  createEvalSchedulerDeps: mocks.createEvalSchedulerDeps,
}));

type UpsertRequest = Parameters<EvalSchedulerDeps["upsertJobExecution"]>[0];
type BlobRequest = Parameters<EvalSchedulerDeps["uploadObservationToS3"]>[0];
type EnqueueRequest = Parameters<EvalSchedulerDeps["enqueueEvalJob"]>[0];

const rules: EvalRules = {
  observationRules: [],
  traceTranscriptRules: [],
};

function createProductionDeps(): EvalSchedulerDeps {
  return {
    upsertJobExecution: vi.fn(async ({ id }: UpsertRequest) => ({ id })),
    uploadObservationToS3: vi.fn(async (_request: BlobRequest) => "s3/path"),
    enqueueEvalJob: vi.fn(async (_request: EnqueueRequest) => undefined),
    traceTranscriptRules: Promise.resolve([]),
    collectTraceActivity: vi.fn(),
    flushTraceActivity: vi.fn(async () => undefined),
  };
}

it("isolates native I/O while comparing repeated and failed intents", async () => {
  const productionDeps = createProductionDeps();
  productionDeps.enqueueEvalJob = vi
    .fn<EvalSchedulerDeps["enqueueEvalJob"]>()
    .mockRejectedValueOnce(new Error("queue unavailable"))
    .mockResolvedValue(undefined);
  mocks.createEvalSchedulerDeps.mockReturnValue(productionDeps);
  const sample = {};
  const primary = new ShadowScope("primary", sample);
  const native = new ShadowScope("native", sample);
  const primaryDeps = otelShadowScope.run(primary, () =>
    createOtelShadowEvalSchedulerDeps({
      projectId: "project",
      rules,
      traceDispatchSamplingRate: 0.5,
      hasSchedulingRows: true,
      enabled: true,
    }),
  );
  const nativeDeps = otelShadowScope.run(native, () =>
    createOtelShadowEvalSchedulerDeps({
      projectId: "project",
      rules,
      traceDispatchSamplingRate: 0.5,
      hasSchedulingRows: true,
      enabled: true,
    }),
  );
  if (!primaryDeps || !nativeDeps) throw new Error("scheduler deps missing");

  const upsert: UpsertRequest = {
    id: "job",
    projectId: "project",
    jobConfigurationId: "rule",
    jobInputTraceId: "trace",
    jobInputObservationId: "observation",
    jobTemplateId: null,
    status: "PENDING" as UpsertRequest["status"],
  };
  const blob: BlobRequest = {
    projectId: "project",
    traceId: "trace",
    observationId: "observation",
    data: { trace_id: "trace", span_id: "observation" } as BlobRequest["data"],
  };
  const enqueue: EnqueueRequest = {
    jobExecutionId: "job",
    projectId: "project",
    observationS3Path: "primary/path",
    delay: 0,
    evalTemplateType: "LLM_AS_JUDGE" as EnqueueRequest["evalTemplateType"],
    evaluatorId: "evaluator",
    evaluationRuleId: "rule",
    variableMapping: [],
  };

  await primaryDeps.upsertJobExecution(upsert);
  await nativeDeps.upsertJobExecution(upsert);
  await primaryDeps.uploadObservationToS3(blob);
  await nativeDeps.uploadObservationToS3(blob);
  await expect(primaryDeps.enqueueEvalJob(enqueue)).rejects.toThrow(
    "queue unavailable",
  );
  await primaryDeps.enqueueEvalJob(enqueue);
  await nativeDeps.enqueueEvalJob({
    ...enqueue,
    observationS3Path: "native/path",
  });
  await nativeDeps.enqueueEvalJob({
    ...enqueue,
    observationS3Path: "native/path",
  });

  // Only requested trace fields compare; serializedEventBytes is pipeline-specific.
  primaryDeps.collectTraceActivity({
    traceId: "trace",
    spanStartTimeISO: "2026-11-24T12:00:00.000Z",
    ruleIds: ["b", "a"],
    serializedEventBytes: 10,
  });
  nativeDeps.collectTraceActivity({
    traceId: "trace",
    spanStartTimeISO: "2026-11-24T12:00:00.000Z",
    ruleIds: ["a", "b"],
    serializedEventBytes: 999,
  });
  await primaryDeps.flushTraceActivity();
  await nativeDeps.flushTraceActivity();

  expect(effectDifferences(primary, native)).toEqual([]);
  expect([...primary.effects.get("eval-enqueue")!.values()]).toEqual([2]);
  expect(primary.failures).toEqual({ "eval-enqueue": 1 });
  expect(productionDeps.upsertJobExecution).toHaveBeenCalledTimes(1);
  expect(productionDeps.uploadObservationToS3).toHaveBeenCalledTimes(1);
  expect(productionDeps.enqueueEvalJob).toHaveBeenCalledTimes(2);
  expect(productionDeps.collectTraceActivity).toHaveBeenCalledTimes(1);
  expect(productionDeps.flushTraceActivity).toHaveBeenCalledTimes(1);
  expect(native.failures).toEqual({});
});

it("keeps an empty native batch inert when primary inputs are absent", () => {
  const native = new ShadowScope("native", {});
  expect(otelShadowScope.run(native, getOtelShadowScheduling)).toEqual({
    rules,
    traceDispatchSamplingRate: 0,
  });
  otelShadowScope.run(native, () =>
    createOtelShadowEvalSchedulerDeps({
      projectId: "project",
      rules,
      hasSchedulingRows: false,
      enabled: false,
    }),
  );
  expect(native.failures).toEqual({});
  expect(mocks.createEvalSchedulerDeps).not.toHaveBeenCalled();
});

beforeEach(() => mocks.createEvalSchedulerDeps.mockReset());
