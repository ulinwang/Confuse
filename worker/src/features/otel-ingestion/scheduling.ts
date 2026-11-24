import type { fetchEvalRules } from "../evaluation/fetchEvalRules";
import type { EvalSchedulerDeps } from "../evaluation/scheduleEvals";
import type { resolveTraceDispatchSamplingRate } from "../traceDispatch/traceDispatchSampling";

export type OtelSchedulingHooks = {
  fetchRules?: typeof fetchEvalRules;
  samplingRate?: typeof resolveTraceDispatchSamplingRate;
  scheduler?: (params: {
    enabled: boolean;
    hasRows: boolean;
    defaultCreate: () => EvalSchedulerDeps;
  }) => EvalSchedulerDeps | null;
};
