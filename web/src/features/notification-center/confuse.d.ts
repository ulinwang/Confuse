export {};

declare global {
  type AgentKind =
    | "kimi-code"
    | "chatgpt-codex"
    | "claude-code"
    | "deepseek-harness";

  type AgentConnectionState =
    | "not-connected"
    | "waiting-for-review"
    | "connecting"
    | "connected"
    | "unsupported"
    | "error";

  interface AgentInfo {
    kind: AgentKind;
    displayName: string;
    installed: boolean;
    version?: string;
    applicationPath?: string;
    configPath?: string;
    connectionState: AgentConnectionState;
    liveCaptureSupported: boolean;
    historySupported: boolean;
    message?: string;
  }

  interface ConnectAgentSelection {
    kind: AgentKind;
    configPath?: string;
    importHistory: boolean;
  }

  interface HistoryPreview {
    kind: AgentKind;
    sessionCount: number;
    oldestAt?: string;
    newestAt?: string;
    includes: string[];
    warnings: string[];
  }

  type JobState =
    | "queued"
    | "running"
    | "waiting-for-review"
    | "succeeded"
    | "partially-succeeded"
    | "failed"
    | "cancelled";

  interface DesktopJob {
    id: string;
    kind: "connect" | "history-import" | "runtime";
    agentKind?: AgentKind;
    state: JobState;
    progress: number;
    message: string;
    createdAt: string;
    updatedAt: string;
  }

  interface DesktopNotification {
    id: string;
    jobId?: string;
    severity: "info" | "success" | "warning" | "error";
    title: string;
    body: string;
    createdAt: string;
    readAt?: string;
    actionRoute?: string;
  }

  interface DesktopState {
    version: 1;
    firstRunComplete: boolean;
    runtime: "starting" | "ready" | "degraded" | "stopped";
    webUrl: string;
    jobs: DesktopJob[];
  }

  interface DesktopRequestMap {
    "desktop.get-state": { request: undefined; response: DesktopState };
    "desktop.complete-onboarding": {
      request: { selections: ConnectAgentSelection[] };
      response: { jobIds: string[] };
    };
    "desktop.reopen-onboarding": { request: undefined; response: undefined };
    "desktop.quit": { request: undefined; response: undefined };
    "agents.scan": { request: undefined; response: AgentInfo[] };
    "agents.connect": {
      request: { selections: ConnectAgentSelection[] };
      response: { jobIds: string[] };
    };
    "history.preview": {
      request: { kinds: AgentKind[] };
      response: HistoryPreview[];
    };
    "history.start": {
      request: { kinds: AgentKind[] };
      response: { jobIds: string[] };
    };
    "jobs.cancel": { request: { id: string }; response: undefined };
    "jobs.retry": { request: { id: string }; response: { jobId: string } };
    "notifications.list": {
      request: undefined;
      response: DesktopNotification[];
    };
    "notifications.mark-read": {
      request: { ids: string[] };
      response: undefined;
    };
  }

  type DesktopChannel = keyof DesktopRequestMap;
  type DesktopRequest<C extends DesktopChannel> =
    DesktopRequestMap[C]["request"];
  type DesktopResponse<C extends DesktopChannel> =
    DesktopRequestMap[C]["response"];

  interface DesktopEventMap {
    "desktop.state-changed": DesktopState;
    "desktop.job-changed": DesktopJob;
    "desktop.notification-created": DesktopNotification;
  }

  interface ConfuseBridge {
    invoke<C extends DesktopChannel>(
      channel: C,
      request: DesktopRequest<C>,
    ): Promise<DesktopResponse<C>>;
    subscribe<C extends keyof DesktopEventMap>(
      channel: C,
      listener: (event: DesktopEventMap[C]) => void,
    ): () => void;
  }

  interface Window {
    confuse?: ConfuseBridge;
  }
}
