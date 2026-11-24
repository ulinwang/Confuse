import type {
  AgentConnectionState,
  AgentInfo,
  AgentKind,
  ConnectAgentSelection,
} from "../../shared/contracts";
import { chatGptCodexAdapter } from "./chatgpt-codex";
import { claudeCodeAdapter } from "./claude-code";
import { createAgentContext } from "./context";
import { deepSeekHarnessAdapter } from "./deepseek-harness";
import { kimiCodeAdapter } from "./kimi-code";
import type {
  AgentAdapter,
  AgentConfigPreview,
  AgentConnectionResult,
  AgentContext,
  LangfuseIngestionEvent,
} from "./types";

const agentRegistry: readonly AgentAdapter[] = [
  kimiCodeAdapter,
  chatGptCodexAdapter,
  claudeCodeAdapter,
  deepSeekHarnessAdapter,
];

function getAgentAdapter(kind: AgentKind): AgentAdapter {
  const adapter = agentRegistry.find((candidate) => candidate.kind === kind);
  if (!adapter) throw new Error(`Unknown Agent kind: ${String(kind)}`);
  return adapter;
}

export async function scanAgents(
  context: AgentContext = createAgentContext(),
): Promise<AgentInfo[]> {
  return Promise.all(agentRegistry.map((adapter) => adapter.discover(context)));
}

export async function previewAgentConnection(
  selection: ConnectAgentSelection,
  context: AgentContext = createAgentContext(),
): Promise<AgentConfigPreview> {
  return getAgentAdapter(selection.kind).preview(selection, context);
}

export async function connectAgents(
  selections: ConnectAgentSelection[],
  context: AgentContext = createAgentContext(),
): Promise<AgentConnectionResult[]> {
  const results: AgentConnectionResult[] = [];
  for (const selection of selections) {
    try {
      results.push(
        await getAgentAdapter(selection.kind).connect(selection, context),
      );
    } catch (error) {
      results.push({
        kind: selection.kind,
        state: "error",
        changed: false,
        importHistory: selection.importHistory,
        preview: {
          kind: selection.kind,
          supported: false,
          changed: false,
          files: [],
        },
        backups: [],
        message:
          error instanceof Error ? error.message : "Agent connection failed",
      });
    }
  }
  return results;
}

export async function disconnectAgents(
  selections: ConnectAgentSelection[],
  context: AgentContext = createAgentContext(),
): Promise<AgentConnectionResult[]> {
  const results: AgentConnectionResult[] = [];
  for (const selection of selections) {
    results.push(
      await getAgentAdapter(selection.kind).disconnect(selection, context),
    );
  }
  return results;
}

export async function detectAgentConnectionState(
  selection: ConnectAgentSelection,
  context: AgentContext = createAgentContext(),
): Promise<AgentConnectionState> {
  return getAgentAdapter(selection.kind).detectStatus(selection, context);
}

export function normalizeAgentPayload(
  kind: AgentKind,
  payload: unknown,
  now?: Date,
): LangfuseIngestionEvent[] {
  return getAgentAdapter(kind).normalizeEvent(payload, now);
}
