import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AGENT_KINDS,
  type AgentInfo,
  type AgentKind,
  type ConnectAgentSelection,
  type HistoryPreview,
} from "../shared/contracts";
import type {
  AgentJobContext,
  AgentJobResult,
  AgentRuntimeAdapter,
} from "./adapters";
import {
  connectAgents,
  detectAgentConnectionState,
  normalizeAgentPayload,
  scanAgents,
} from "./agents";
import { agentPaths } from "./agents/adapter-utils";
import type { AgentContext } from "./agents/types";
import { discoverJsonlHistorySources } from "./history/discovery";
import { openDshHistory } from "./history/dsh";
import { HistoryService } from "./history/service";
import type { HistorySource, JsonlAgentKind } from "./history/types";
import type { JobManager } from "./jobs";
import type { DesktopStore } from "./store";
import { ingestionToTelemetry } from "./telemetry/ingestion";
import type { OutboxEntry } from "./telemetry/types";

const hookEnvelope = z
  .object({
    source: z.literal("confuse-agent-hook"),
    agent: z.enum(AGENT_KINDS),
    sentAt: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const codexConnectPayload = z
  .object({
    selections: z.tuple([
      z
        .object({
          kind: z.literal("chatgpt-codex"),
          configPath: z.string().min(1).max(4_096).optional(),
          importHistory: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();

const CONFIGURATION_FILES = {
  "kimi-code": "config.toml",
  "chatgpt-codex": "hooks.json",
  "claude-code": "settings.json",
  "deepseek-harness": "cordis.patch.yml",
} as const;

export interface AgentRuntimeAdapterDependencies {
  context: AgentContext;
  store: DesktopStore;
  jobs: JobManager;
  onEnqueued?: () => void;
}

export class DesktopAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly context: AgentContext;
  private readonly store: DesktopStore;
  private readonly jobs: JobManager;
  private readonly onEnqueued?: () => void;
  private resumePromise?: Promise<void>;
  private codexExecutionObservedJobId?: string;

  constructor(dependencies: AgentRuntimeAdapterDependencies) {
    this.context = dependencies.context;
    this.store = dependencies.store;
    this.jobs = dependencies.jobs;
    this.onEnqueued = dependencies.onEnqueued;
  }

  async scan(): Promise<AgentInfo[]> {
    const discovered = await scanAgents(this.context);
    return Promise.all(
      discovered.map(async (info) => {
        const selection = this.selectionFor(info.kind);
        let connectionState = info.connectionState;
        let message = info.message;
        try {
          connectionState = await detectAgentConnectionState(
            selection,
            this.context,
          );
        } catch (error) {
          connectionState = "error";
          message = errorMessage(error);
        }
        return {
          ...info,
          configPath: selection.configPath ?? info.configPath,
          connectionState,
          historySupported: info.historySupported,
          ...(message === undefined ? {} : { message }),
        };
      }),
    );
  }

  async connect(
    selection: ConnectAgentSelection,
    context: AgentJobContext,
  ): Promise<AgentJobResult> {
    context.report(0.1, `Connecting ${selection.kind}`);
    const expectedConfigPath = agentPaths(
      { kind: selection.kind, importHistory: selection.importHistory },
      this.context,
      environmentHome(selection.kind, this.context),
      defaultHome(selection.kind, this.context),
      CONFIGURATION_FILES[selection.kind],
    ).configPath;
    if (
      selection.configPath !== undefined &&
      resolve(selection.configPath) !== resolve(expectedConfigPath)
    ) {
      throw new Error(
        "Agent configuration must be the discovered path or a path provided by the Agent environment",
      );
    }
    const [result] = await connectAgents([selection], this.context);
    if (
      result.state === "error" ||
      result.state === "not-connected" ||
      result.state === "unsupported"
    ) {
      throw new Error(result.message);
    }

    let connectionState = result.state;
    let message = result.message;
    let state: AgentJobResult["state"] =
      result.state === "waiting-for-review"
        ? "waiting-for-review"
        : "succeeded";
    if (result.state === "waiting-for-review") {
      try {
        const detected = await detectAgentConnectionState(
          selection,
          this.context,
        );
        if (detected === "connected") {
          connectionState = "connected";
          state = "succeeded";
          message = `${message} Hook trust verified.`;
        }
      } catch {
        connectionState = "waiting-for-review";
      }
    }
    this.store.saveAgentConnection(selection, connectionState);

    if (!selection.importHistory) {
      try {
        const count = await this.recordWatermarks(
          selection.kind,
          context.signal,
        );
        message = `${message} History starts after the current position in ${count} discovered source(s).`;
      } catch (error) {
        if (state === "waiting-for-review") {
          message = `${message} The history watermark could not be recorded: ${errorMessage(error)}`;
        } else {
          state = "partially-succeeded";
          message = `${message} Live capture is configured, but the history watermark could not be recorded: ${errorMessage(error)}`;
        }
      }
    }
    return { state, message };
  }

  async previewHistory(kinds: AgentKind[]): Promise<HistoryPreview[]> {
    const previews: HistoryPreview[] = [];
    for (const kind of kinds) {
      previews.push(
        ...(await this.withHistoryService(kind, undefined, (service) =>
          service.preview([kind]),
        )),
      );
    }
    return previews;
  }

  async importHistory(
    kind: AgentKind,
    context: AgentJobContext,
  ): Promise<AgentJobResult> {
    context.report(0.1, `Discovering authorized ${kind} history`);
    const [result] = await this.withHistoryService(
      kind,
      context.signal,
      (service) =>
        service.import([kind], {
          signal: context.signal,
          onProgress: (progress) => {
            context.report(
              0.9,
              `${kind}: ${progress.enqueued} event(s) queued, ${progress.duplicates} duplicate(s)`,
            );
          },
        }),
    );
    if (result.enqueued > 0) this.onEnqueued?.();
    const message = historyResultMessage(result);
    if (result.state === "failed") throw new Error(message);
    return {
      state:
        result.state === "partially-succeeded" || result.state === "cancelled"
          ? "partially-succeeded"
          : "succeeded",
      message,
    };
  }

  async resumeWaitingCodexJobs(): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    const resume = this.performWaitingCodexJobResume();
    this.resumePromise = resume;
    try {
      await resume;
    } finally {
      if (this.resumePromise === resume) this.resumePromise = undefined;
    }
  }

  private async performWaitingCodexJobResume(): Promise<void> {
    const waiting = this.waitingCodexJob();
    if (!waiting) {
      this.codexExecutionObservedJobId = undefined;
      return;
    }
    if (this.codexExecutionObservedJobId !== waiting.id) {
      this.codexExecutionObservedJobId = undefined;
    }

    try {
      const record = this.store.getJob(waiting.id);
      const parsed = codexConnectPayload.safeParse(record.payload);
      if (!parsed.success) return;
      const detected = await detectAgentConnectionState(
        parsed.data.selections[0],
        this.context,
      );
      if (detected !== "connected") return;
      if (this.store.getJob(waiting.id).job.state === "waiting-for-review") {
        if (this.codexExecutionObservedJobId === waiting.id) {
          this.codexExecutionObservedJobId = undefined;
        }
        this.jobs.retry(waiting.id);
      }
    } catch {
      return;
    }
  }

  private waitingCodexJob() {
    return this.store
      .listJobs()
      .filter(
        (job) =>
          job.kind === "connect" &&
          job.agentKind === "chatgpt-codex" &&
          job.state === "waiting-for-review",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  }

  async ingestLiveEvent(input: unknown): Promise<number> {
    const parsed = hookEnvelope.safeParse(input);
    if (!parsed.success) return 0;
    let events;
    try {
      events = normalizeAgentPayload(parsed.data.agent, parsed.data);
    } catch {
      return 0;
    }
    if (events.length === 0) return 0;

    const now = new Date().toISOString();
    let inserted = false;
    for (const event of events) {
      const telemetry = ingestionToTelemetry(parsed.data.agent, event);
      const entry: OutboxEntry = {
        id: telemetry.id,
        event: telemetry,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      };
      inserted = (await this.store.putIfAbsent(entry)) || inserted;
    }
    this.onEnqueued?.();
    if (parsed.data.agent === "chatgpt-codex" && inserted) {
      const waiting = this.waitingCodexJob();
      if (!waiting) {
        this.codexExecutionObservedJobId = undefined;
      } else if (this.codexExecutionObservedJobId !== waiting.id) {
        this.codexExecutionObservedJobId = waiting.id;
        await this.resumeWaitingCodexJobs();
      }
    }
    return events.length;
  }

  private async recordWatermarks(
    kind: AgentKind,
    signal: AbortSignal,
  ): Promise<number> {
    return this.withHistoryService(kind, signal, async (service, count) => {
      await service.recordWatermarks([kind], signal);
      return count;
    });
  }

  private async withHistoryService<T>(
    kind: AgentKind,
    signal: AbortSignal | undefined,
    operation: (service: HistoryService, sourceCount: number) => Promise<T>,
  ): Promise<T> {
    if (kind === "deepseek-harness") {
      const connection = await openDshHistory(
        join(this.homeFor(kind), "sessions"),
        { signal },
      );
      try {
        return await operation(
          this.createHistoryService(connection.sources),
          connection.sources.length,
        );
      } finally {
        await connection.close();
      }
    }
    const sources = await this.sourcesFor(kind);
    return operation(this.createHistoryService(sources), sources.length);
  }

  private createHistoryService(sources: HistorySource[]): HistoryService {
    return new HistoryService({
      sources,
      store: this.store,
      outbox: this.store,
    });
  }

  private homeFor(kind: AgentKind): string {
    return agentPaths(
      this.selectionFor(kind),
      this.context,
      environmentHome(kind, this.context),
      defaultHome(kind, this.context),
      CONFIGURATION_FILES[kind],
    ).home;
  }

  private async sourcesFor(
    kind: Exclude<AgentKind, "deepseek-harness">,
  ): Promise<HistorySource[]> {
    const selection = this.selectionFor(kind) as ConnectAgentSelection & {
      kind: JsonlAgentKind;
    };
    return discoverJsonlHistorySources(selection, this.homeFor(kind));
  }

  private selectionFor(kind: AgentKind): ConnectAgentSelection {
    return (
      this.store.getAgentConnection(kind)?.selection ?? {
        kind,
        importHistory: false,
      }
    );
  }
}

function environmentHome(
  kind: AgentKind,
  context: AgentContext,
): string | undefined {
  switch (kind) {
    case "kimi-code":
      return context.env.KIMI_CODE_HOME;
    case "chatgpt-codex":
      return context.env.CODEX_HOME;
    case "claude-code":
      return context.env.CLAUDE_CONFIG_DIR;
    case "deepseek-harness":
      return context.env.DSH_HOME;
  }
}

function defaultHome(kind: AgentKind, context: AgentContext): string {
  switch (kind) {
    case "kimi-code":
      return `${context.homeDir}/.kimi-code`;
    case "chatgpt-codex":
      return `${context.homeDir}/.codex`;
    case "claude-code":
      return `${context.homeDir}/.claude`;
    case "deepseek-harness":
      return `${context.homeDir}/.dsh`;
  }
}

function historyResultMessage(result: {
  scanned: number;
  enqueued: number;
  duplicates: number;
  skipped: number;
  malformed: number;
  warnings: string[];
}): string {
  const summary = `Scanned ${result.scanned} record(s); queued ${result.enqueued}, duplicates ${result.duplicates}, skipped ${result.skipped}, malformed ${result.malformed}.`;
  return [summary, ...result.warnings].join(" ");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
