import type {
  AgentConnectionState,
  AgentInfo,
  AgentKind,
  ConnectAgentSelection,
} from "../../shared/contracts";

export type HookTransport =
  | { type: "unix-socket"; socketPath: string }
  | { type: "http"; url: string };

export interface AgentContext {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  applicationDirs: string[];
  nodePath: string;
  transport: HookTransport;
  now: () => Date;
  isCodexHookTrusted?: (
    command: string,
    sourcePath: string,
  ) => Promise<boolean>;
}

export interface AgentFilePreview {
  path: string;
  action: "create" | "update" | "delete";
  beforeSha256?: string;
  afterSha256?: string;
  patch: string;
}

export interface AgentConfigPreview {
  kind: AgentKind;
  supported: boolean;
  changed: boolean;
  files: AgentFilePreview[];
  message?: string;
}

export interface AgentBackup {
  originalPath: string;
  backupPath?: string;
}

export interface AgentConnectionResult {
  kind: AgentKind;
  state: AgentConnectionState;
  changed: boolean;
  importHistory: boolean;
  preview: AgentConfigPreview;
  backups: AgentBackup[];
  message: string;
}

export interface PlannedWrite {
  path: string;
  before: string | null;
  after: string | null;
  preview: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  discover(context: AgentContext): Promise<AgentInfo>;
  preview(
    selection: ConnectAgentSelection,
    context: AgentContext,
  ): Promise<AgentConfigPreview>;
  connect(
    selection: ConnectAgentSelection,
    context: AgentContext,
  ): Promise<AgentConnectionResult>;
  disconnect(
    selection: ConnectAgentSelection,
    context: AgentContext,
  ): Promise<AgentConnectionResult>;
  detectStatus(
    selection: ConnectAgentSelection,
    context: AgentContext,
  ): Promise<AgentConnectionState>;
  normalizeEvent(payload: unknown, now?: Date): LangfuseIngestionEvent[];
}

export interface LangfuseUsage {
  input?: number;
  output?: number;
  total?: number;
  unit: "TOKENS";
}

interface LangfuseTraceBody {
  id: string;
  name: string;
  sessionId: string;
  timestamp: string;
  userId?: string;
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
}

export interface LangfuseObservationBody {
  id: string;
  traceId: string;
  parentObservationId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  usage?: LangfuseUsage;
  level?: "DEFAULT" | "ERROR";
  statusMessage?: string;
  metadata: Record<string, unknown>;
}

export type LangfuseIngestionEvent =
  | {
      id: string;
      type: "trace-create";
      timestamp: string;
      body: LangfuseTraceBody;
    }
  | {
      id: string;
      type: "span-create" | "generation-create" | "event-create";
      timestamp: string;
      body: LangfuseObservationBody;
    };
