import type { EvalRules } from "../../evaluation/fetchEvalRules";
import {
  createEvalSchedulerDeps,
  type EvalSchedulerDeps,
} from "../../evaluation/scheduleEvals";
import type { TraceSpanActivity } from "../../traceDispatch/traceRuleRecording";
import { otelShadowScope, type ShadowScope } from "./context";

type EvalEnqueueRequest = Parameters<EvalSchedulerDeps["enqueueEvalJob"]>[0];

type SampleState = {
  rules: EvalRules;
  traceDispatchSamplingRate: number;
  schedulingInputsAvailable: boolean;
  schedulerDeps?: EvalSchedulerDeps;
};

const emptyScheduling = {
  rules: { observationRules: [], traceTranscriptRules: [] } as EvalRules,
  traceDispatchSamplingRate: 0,
};
const samples = new WeakMap<object, SampleState>();

function enqueueIdentity(request: EvalEnqueueRequest) {
  // Native uses a synthetic path because shadow must not write S3. Keep every
  // other scheduler-significant field in the comparison.
  const { observationS3Path: _observationS3Path, ...identity } = request;
  return identity;
}

function traceIdentity(activity: TraceSpanActivity) {
  return {
    traceId: activity.traceId,
    spanStartTimeISO: activity.spanStartTimeISO,
    ruleIds: [...activity.ruleIds].sort(),
  };
}

async function captureRequest<T>(
  scope: ShadowScope,
  kind: string,
  identity: unknown,
  call: () => Promise<T>,
): Promise<T> {
  scope.record(kind, identity);
  try {
    return await call();
  } catch (error) {
    scope.fail(kind);
    throw error;
  }
}

function wrapSchedulerDeps(
  base: EvalSchedulerDeps,
  scope: ShadowScope,
): EvalSchedulerDeps {
  return {
    ...base,
    upsertJobExecution: (request) =>
      captureRequest(scope, "eval-upsert", request, () =>
        base.upsertJobExecution(request),
      ),
    uploadObservationToS3: (request) =>
      captureRequest(scope, "eval-blob-upload", request, () =>
        base.uploadObservationToS3(request),
      ),
    enqueueEvalJob: (request) =>
      captureRequest(scope, "eval-enqueue", enqueueIdentity(request), () =>
        base.enqueueEvalJob(request),
      ),
    collectTraceActivity: (activity) => {
      scope.record("trace-recording", traceIdentity(activity));
      base.collectTraceActivity(activity);
    },
    flushTraceActivity: async () => {
      try {
        await base.flushTraceActivity();
      } catch (error) {
        scope.fail("trace-flush");
        throw error;
      }
    },
  };
}

function createNativeSchedulerDeps(
  state: SampleState | undefined,
): EvalSchedulerDeps {
  return {
    upsertJobExecution: async ({ id }) => ({ id }),
    uploadObservationToS3: async () => "shadow://eval",
    enqueueEvalJob: async () => undefined,
    traceTranscriptRules:
      state?.schedulingInputsAvailable && state.schedulerDeps
        ? state.schedulerDeps.traceTranscriptRules
        : Promise.resolve([]),
    collectTraceActivity: () => undefined,
    flushTraceActivity: async () => undefined,
  };
}

/**
 * Use production scheduler dependencies for primary and redirect only their
 * I/O for native replay. Matching and rule preparation stay production code.
 */
export function createOtelShadowEvalSchedulerDeps(params: {
  projectId: string;
  rules: EvalRules;
  traceDispatchSamplingRate?: number;
  schedulingInputsAvailable?: boolean;
  hasSchedulingRows?: boolean;
  enabled: boolean;
}): EvalSchedulerDeps | null {
  const scope = otelShadowScope.getStore();
  if (!scope) {
    return params.enabled
      ? createEvalSchedulerDeps(params.projectId, params.rules)
      : null;
  }

  if (scope.side === "primary") {
    const schedulerDeps = params.enabled
      ? createEvalSchedulerDeps(params.projectId, params.rules, {
          onTraceActivityFailure: () => scope.fail("trace-flush"),
        })
      : undefined;
    samples.set(scope.sample, {
      rules: params.rules,
      traceDispatchSamplingRate: params.traceDispatchSamplingRate ?? 0,
      schedulingInputsAvailable: params.schedulingInputsAvailable ?? true,
      schedulerDeps,
    });
    return schedulerDeps ? wrapSchedulerDeps(schedulerDeps, scope) : null;
  }

  const state = samples.get(scope.sample);
  if (
    params.hasSchedulingRows &&
    (!state || !state.schedulingInputsAvailable)
  ) {
    scope.fail("scheduling_inputs_unavailable");
  }
  return params.enabled
    ? wrapSchedulerDeps(createNativeSchedulerDeps(state), scope)
    : null;
}

export function getOtelShadowScheduling():
  | Pick<SampleState, "rules" | "traceDispatchSamplingRate">
  | undefined {
  const scope = otelShadowScope.getStore();
  if (scope?.side !== "native") return undefined;

  const state = samples.get(scope.sample);
  return state?.schedulingInputsAvailable ? state : emptyScheduling;
}
