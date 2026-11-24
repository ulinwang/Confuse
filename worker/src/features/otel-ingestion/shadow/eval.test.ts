import { expect, it, vi } from "vitest";

import type { EvalRules } from "../../evaluation/fetchEvalRules";
import type { EvalSchedulerDeps } from "../../evaluation/scheduleEvals";
import { effectDifferences, ShadowScope } from "./context";
import { schedulingHooks } from "./eval";

type UpsertRequest = Parameters<EvalSchedulerDeps["upsertJobExecution"]>[0];
type BlobRequest = Parameters<EvalSchedulerDeps["uploadObservationToS3"]>[0];
type EnqueueRequest = Parameters<EvalSchedulerDeps["enqueueEvalJob"]>[0];

const rules: EvalRules = {
  observationRules: [],
  traceTranscriptRules: [],
};

function productionDeps(): EvalSchedulerDeps {
  return {
    upsertJobExecution: vi.fn(async ({ id }: UpsertRequest) => ({ id })),
    uploadObservationToS3: vi.fn(async (_request: BlobRequest) => "s3/path"),
    enqueueEvalJob: vi.fn(async (_request: EnqueueRequest) => undefined),
    traceTranscriptRules: Promise.resolve([]),
    collectTraceActivity: vi.fn(),
    flushTraceActivity: vi.fn(async () => undefined),
  };
}

it("captures equal intents, repeated requests, and primary failures independently", async () => {
  const production = productionDeps();
  production.enqueueEvalJob = vi
    .fn<EvalSchedulerDeps["enqueueEvalJob"]>()
    .mockRejectedValueOnce(new Error("queue unavailable"))
    .mockResolvedValue(undefined);
  const sample = {};
  const primary = new ShadowScope("primary", sample);
  const native = new ShadowScope("native", sample);
  const primaryDeps = schedulingHooks(primary).scheduler!({
    enabled: true,
    hasRows: false,
    defaultCreate: () => production,
  });
  const nativeDeps = schedulingHooks(native).scheduler!({
    enabled: true,
    hasRows: false,
    defaultCreate: () => {
      throw new Error("native must not create production deps");
    },
  });
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
  await expect(nativeDeps.enqueueEvalJob(enqueue)).rejects.toThrow(
    "No successful primary result for this operation",
  );
  await nativeDeps.enqueueEvalJob(enqueue);

  // Activity matching excludes pipeline-specific serialized byte estimates.
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

  expect(effectDifferences(primary)).toEqual([]);
  expect(primary.failures).toEqual({ "eval-enqueue": 1 });
  expect(production.upsertJobExecution).toHaveBeenCalledTimes(1);
  expect(production.uploadObservationToS3).toHaveBeenCalledTimes(1);
  expect(production.enqueueEvalJob).toHaveBeenCalledTimes(2);
  expect(production.collectTraceActivity).toHaveBeenCalledTimes(1);
  expect(production.flushTraceActivity).toHaveBeenCalledTimes(1);
  expect(native.failures).toEqual({ "eval-enqueue": 1 });
});

it("keeps empty native scheduling inert and reports missing primary inputs only for rows", async () => {
  const native = new ShadowScope("native", {});
  const hooks = schedulingHooks(native);
  const create = vi.fn(() => productionDeps());

  await expect(hooks.samplingRate!("project")).resolves.toBe(0);
  await expect(
    hooks.fetchRules!("project", { includeTraceTranscriptRules: false }),
  ).resolves.toEqual(rules);
  expect(
    hooks.scheduler!({
      enabled: false,
      hasRows: false,
      defaultCreate: create,
    }),
  ).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(native.failures).toEqual({});

  hooks.scheduler!({
    enabled: false,
    hasRows: true,
    defaultCreate: create,
  });
  expect(native.failures).toEqual({ scheduling_inputs_unavailable: 1 });
});
