import type { EvalRules } from "../../evaluation/fetchEvalRules";
import { fetchEvalRules } from "../../evaluation/fetchEvalRules";
import type { EvalSchedulerDeps } from "../../evaluation/scheduleEvals";
import { resolveTraceDispatchSamplingRate } from "../../traceDispatch/traceDispatchSampling";
import type { TraceSpanActivity } from "../../traceDispatch/traceRuleRecording";
import type { OtelSchedulingHooks } from "../scheduling";
import type { ShadowScope } from "./context";

const emptyRules: EvalRules = {
  observationRules: [],
  traceTranscriptRules: [],
};

function traceIdentity(activity: TraceSpanActivity) {
  return {
    traceId: activity.traceId,
    spanStartTimeISO: activity.spanStartTimeISO,
    ruleIds: [...activity.ruleIds].sort(),
  };
}

function capturedDeps(
  scope: ShadowScope,
  deps: EvalSchedulerDeps | undefined,
): EvalSchedulerDeps {
  function production() {
    if (!deps)
      throw new Error("Shadow scheduling cannot call production services");
    return deps;
  }
  return {
    upsertJobExecution: (request) =>
      scope.effect("eval-upsert", request, () =>
        production().upsertJobExecution(request),
      ),
    uploadObservationToS3: (request) =>
      scope.effect("eval-blob-upload", request, () =>
        production().uploadObservationToS3(request),
      ),
    enqueueEvalJob: (request) =>
      scope.effect("eval-enqueue", request, () =>
        production().enqueueEvalJob(request),
      ),
    get traceTranscriptRules() {
      return scope.effect(
        "trace-rules",
        "batch",
        () => production().traceTranscriptRules,
      );
    },
    collectTraceActivity: (activity) => {
      scope.record("trace-recording", traceIdentity(activity));
      if (scope.side === "primary") deps?.collectTraceActivity(activity);
    },
    flushTraceActivity: () =>
      scope.effect("trace-flush", "batch", () =>
        production().flushTraceActivity(),
      ),
  };
}

export function schedulingHooks(scope: ShadowScope): OtelSchedulingHooks {
  const primary = scope.side === "primary";
  return {
    samplingRate: async (projectId) => {
      if (!primary && !scope.effects.has("sampling-rate")) return 0;
      return scope.effect("sampling-rate", projectId, () =>
        resolveTraceDispatchSamplingRate(projectId),
      );
    },
    fetchRules: async (projectId, options) => {
      if (!primary && !scope.effects.has("eval-rules")) return emptyRules;
      return scope.effect("eval-rules", { projectId, ...options }, () =>
        fetchEvalRules(projectId, options),
      );
    },
    scheduler: ({ enabled, hasRows, defaultCreate }) => {
      if (!primary && hasRows && !scope.effects.has("eval-rules")) {
        scope.fail("scheduling_inputs_unavailable");
      }
      if (!enabled) return null;
      return capturedDeps(scope, primary ? defaultCreate() : undefined);
    },
  };
}
