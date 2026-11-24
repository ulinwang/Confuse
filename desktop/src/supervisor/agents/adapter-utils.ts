import { basename, dirname, join } from "node:path";
import type {
  AgentConnectionState,
  AgentKind,
  ConnectAgentSelection,
} from "../../shared/contracts";
import { commitWrites, createPreview } from "./filesystem";
import { normalizeAgentEvent } from "./events";
import type {
  AgentConfigPreview,
  AgentConnectionResult,
  AgentContext,
  LangfuseIngestionEvent,
  PlannedWrite,
} from "./types";

export function agentPaths(
  selection: ConnectAgentSelection,
  context: AgentContext,
  environmentHome: string | undefined,
  defaultHome: string,
  configName: string,
): { home: string; configPath: string } {
  const explicit = selection.configPath;
  if (explicit !== undefined && basename(explicit) === configName) {
    return { home: dirname(explicit), configPath: explicit };
  }
  const home = explicit ?? environmentHome ?? defaultHome;
  return { home, configPath: join(home, configName) };
}

export async function connectWithWrites(
  kind: AgentKind,
  selection: ConnectAgentSelection,
  context: AgentContext,
  writes: PlannedWrite[],
  state: AgentConnectionState,
  message: string,
): Promise<AgentConnectionResult> {
  const backups = await commitWrites(writes, context.now());
  return {
    kind,
    state,
    changed: writes.some((write) => write.before !== write.after),
    importHistory: selection.importHistory,
    preview: createPreview(kind, writes, message),
    backups,
    message,
  };
}

export function unchangedResult(
  kind: AgentKind,
  selection: ConnectAgentSelection,
  state: AgentConnectionState,
  message: string,
): AgentConnectionResult {
  return {
    kind,
    state,
    changed: false,
    importHistory: selection.importHistory,
    preview: {
      kind,
      supported: state !== "unsupported",
      changed: false,
      files: [],
      message,
    },
    backups: [],
    message,
  };
}

export function unsupportedPreview(
  kind: AgentKind,
  message: string,
): AgentConfigPreview {
  return { kind, supported: false, changed: false, files: [], message };
}

export function normalize(
  kind: AgentKind,
  payload: unknown,
  now?: Date,
): LangfuseIngestionEvent[] {
  return normalizeAgentEvent(kind, payload, now);
}
