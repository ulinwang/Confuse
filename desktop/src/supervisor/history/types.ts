import type { AgentKind } from "../../shared/contracts.js";
import type { OutboxStore } from "../telemetry/types.js";

export type JsonlAgentKind = Exclude<AgentKind, "deepseek-harness">;
export type HistoryCompression = "none" | "zstd";

export interface JsonlCursor {
  kind: "jsonl";
  identity: string;
  compression: HistoryCompression;
  offset: number;
  size: number;
  mtimeMs: number;
  lastCompleteLine?: string;
}

export interface DshCursor {
  kind: "dsh";
  sessionId: string;
  formatVersion: string;
  lastSeq?: string;
}

export type HistoryCursor = JsonlCursor | DshCursor;

export interface JsonlHistorySource {
  kind: "jsonl";
  id: string;
  agent: JsonlAgentKind;
  root: string;
  relativePath: string;
  compression?: HistoryCompression;
  sessionId?: string;
  workspaceId?: string;
  rolloutId?: string;
  transcriptId?: string;
}

export interface DshSessionEvent {
  sessionId: string;
  formatVersion: string;
  seq: string | number | bigint;
  type: string;
  timestamp?: string;
  payload: unknown;
  model?: string;
  usageDetails?: Record<string, number>;
}

export interface DshSessionQuery {
  readEvents(request: {
    sessionId: string;
    formatVersion: string;
    afterSeq?: string;
    signal?: AbortSignal;
  }): AsyncIterable<DshSessionEvent>;
}

export interface DshHistorySource {
  kind: "dsh";
  id: string;
  agent: "deepseek-harness";
  sessionId: string;
  formatVersion: string;
  reader: DshSessionQuery;
}

export type HistorySource = JsonlHistorySource | DshHistorySource;

export interface HistoryEvent {
  agent: AgentKind;
  sessionId: string;
  dedupKey: string;
  name: string;
  type: "agent" | "event" | "generation" | "span" | "tool";
  timestamp?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface HistoryParseContext {
  sourceId: string;
  sessionId?: string;
  workspaceId?: string;
  rolloutId?: string;
  transcriptId?: string;
}

export interface HistoryStore {
  getCursor(sourceId: string): Promise<HistoryCursor | undefined>;
  saveCursor(sourceId: string, cursor: HistoryCursor): Promise<void>;
}

export interface HistoryImportResult {
  kind: AgentKind;
  state: "succeeded" | "partially-succeeded" | "failed" | "cancelled";
  scanned: number;
  enqueued: number;
  duplicates: number;
  skipped: number;
  malformed: number;
  warnings: string[];
}

export interface HistoryServiceOptions {
  sources: readonly HistorySource[];
  store: HistoryStore;
  outbox: Pick<OutboxStore, "putIfAbsent">;
  now?: () => Date;
  cursorNamespace?: string;
}

export interface HistoryImportOptions {
  signal?: AbortSignal;
  onProgress?: (result: HistoryImportResult) => void;
}
