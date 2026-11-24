import type {
  AgentInfo,
  AgentKind,
  ConnectAgentSelection,
  HistoryPreview,
} from "../shared/contracts";

export interface AgentJobContext {
  signal: AbortSignal;
  report(progress: number, message: string): void;
}

export interface AgentRuntimeAdapter {
  scan(): Promise<AgentInfo[]>;
  connect(
    selection: ConnectAgentSelection,
    context: AgentJobContext,
  ): Promise<AgentJobResult>;
  previewHistory(kinds: AgentKind[]): Promise<HistoryPreview[]>;
  importHistory(
    kind: AgentKind,
    context: AgentJobContext,
  ): Promise<AgentJobResult>;
}

export interface AgentJobResult {
  state?: "succeeded" | "partially-succeeded" | "waiting-for-review";
  message: string;
}
