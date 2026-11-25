import { createHash } from "node:crypto";
import type {
  DshSessionEvent,
  HistoryEvent,
  HistoryParseContext,
  JsonlAgentKind,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export function parseJsonlHistoryEvent(
  agent: JsonlAgentKind,
  raw: string,
  context: HistoryParseContext,
): HistoryEvent | undefined {
  const record = asRecord(JSON.parse(raw));
  if (!record) return undefined;

  switch (agent) {
    case "kimi-code":
      return parseKimi(record, raw, context);
    case "chatgpt-codex":
      return parseCodex(record, raw, context);
    case "claude-code":
      return parseClaude(record, raw, context);
  }
}

export function parseDshHistoryEvent(event: DshSessionEvent): HistoryEvent {
  return {
    agent: "deepseek-harness",
    sessionId: event.sessionId,
    dedupKey: stableKey([
      event.sessionId,
      event.formatVersion,
      String(event.seq),
    ]),
    name: event.type,
    type: observationType(event.type, event.payload),
    timestamp: normalizeTimestamp(event.timestamp),
    input: inputFor(event.type, event.payload),
    output: outputFor(event.type, event.payload),
    model: event.model,
    usageDetails: event.usageDetails,
    metadata: {
      formatVersion: event.formatVersion,
      seq: String(event.seq),
    },
  };
}

function parseKimi(
  record: UnknownRecord,
  raw: string,
  context: HistoryParseContext,
): HistoryEvent | undefined {
  const message = asRecord(record.message);
  const payload = asRecord(record.payload);
  const type =
    stringValue(record.type) ?? stringValue(message?.role) ?? "event";
  if (!isKnownType("kimi-code", type, record, message, payload))
    return undefined;

  const sessionId =
    firstString(
      record.sessionId,
      record.session_id,
      message?.sessionId,
      payload?.sessionId,
    ) ?? context.sessionId;
  if (!sessionId) return undefined;
  const workspace =
    firstString(
      record.workspaceId,
      record.workspace_id,
      record.workspace,
      record.cwd,
      record.projectPath,
      record.project_path,
    ) ??
    context.workspaceId ??
    context.sourceId;
  const eventId =
    firstString(
      record.eventId,
      record.event_id,
      record.id,
      record.uuid,
      message?.id,
      payload?.id,
    ) ?? contentId(raw);

  return buildEvent({
    agent: "kimi-code",
    sessionId,
    dedupKey: stableKey([workspace, sessionId, eventId]),
    type,
    timestamp: firstString(
      record.timestamp,
      record.createdAt,
      record.created_at,
    ),
    record,
    message,
    payload,
  });
}

function parseCodex(
  record: UnknownRecord,
  raw: string,
  context: HistoryParseContext,
): HistoryEvent | undefined {
  const payload = asRecord(record.payload);
  const item = asRecord(payload?.item) ?? asRecord(record.item);
  const message = asRecord(record.message) ?? asRecord(item?.message);
  const type =
    stringValue(item?.type) ??
    stringValue(payload?.type) ??
    stringValue(record.type) ??
    "event";
  if (!isKnownType("chatgpt-codex", type, record, message, payload))
    return undefined;

  const sessionId =
    firstString(
      record.threadId,
      record.thread_id,
      payload?.threadId,
      payload?.thread_id,
      payload?.sessionId,
      payload?.session_id,
    ) ?? context.sessionId;
  if (!sessionId) return undefined;
  const rollout =
    firstString(
      record.rolloutId,
      record.rollout_id,
      payload?.rolloutId,
      payload?.rollout_id,
    ) ??
    context.rolloutId ??
    context.sourceId;
  const turn =
    firstString(
      record.turnId,
      record.turn_id,
      payload?.turnId,
      payload?.turn_id,
      item?.turnId,
      item?.turn_id,
    ) ?? "session";
  const itemId =
    firstString(
      record.itemId,
      record.item_id,
      item?.id,
      payload?.id,
      record.id,
    ) ?? contentId(raw);

  return buildEvent({
    agent: "chatgpt-codex",
    sessionId,
    dedupKey: stableKey([sessionId, rollout, turn, itemId]),
    type,
    timestamp: firstString(
      record.timestamp,
      record.createdAt,
      payload?.timestamp,
    ),
    record,
    message,
    payload: item ?? payload,
  });
}

function parseClaude(
  record: UnknownRecord,
  raw: string,
  context: HistoryParseContext,
): HistoryEvent | undefined {
  const message = asRecord(record.message);
  const payload = asRecord(record.payload);
  const type =
    stringValue(record.type) ?? stringValue(message?.role) ?? "event";
  if (!isKnownType("claude-code", type, record, message, payload))
    return undefined;

  const sessionId =
    firstString(record.sessionId, record.session_id, message?.sessionId) ??
    context.sessionId;
  if (!sessionId) return undefined;
  const transcript =
    firstString(
      record.transcriptPath,
      record.transcript_path,
      record.transcriptId,
    ) ??
    context.transcriptId ??
    context.sourceId;
  const entryId =
    firstString(
      record.uuid,
      record.entryUuid,
      record.entry_uuid,
      record.id,
      message?.id,
    ) ?? contentId(raw);

  return buildEvent({
    agent: "claude-code",
    sessionId,
    dedupKey: stableKey([sessionId, transcript, entryId]),
    type,
    timestamp: firstString(
      record.timestamp,
      record.createdAt,
      record.created_at,
    ),
    record,
    message,
    payload,
  });
}

function buildEvent(input: {
  agent: JsonlAgentKind;
  sessionId: string;
  dedupKey: string;
  type: string;
  timestamp?: string;
  record: UnknownRecord;
  message?: UnknownRecord;
  payload?: UnknownRecord;
}): HistoryEvent {
  const body = input.payload ?? input.message ?? input.record;
  const model = firstString(
    input.record.model,
    input.message?.model,
    input.payload?.model,
    asRecord(input.record.response)?.model,
  );
  const usage =
    normalizeUsage(input.record.usage) ??
    normalizeUsage(input.message?.usage) ??
    normalizeUsage(input.payload?.usage);

  return {
    agent: input.agent,
    sessionId: input.sessionId,
    dedupKey: input.dedupKey,
    name: input.type,
    type: observationType(input.type, body),
    timestamp: normalizeTimestamp(input.timestamp),
    input: inputFor(input.type, body),
    output: outputFor(input.type, body),
    model,
    usageDetails: usage,
    metadata: {
      historical: true,
    },
  };
}

function isKnownType(
  agent: JsonlAgentKind,
  type: string,
  record: UnknownRecord,
  message?: UnknownRecord,
  payload?: UnknownRecord,
): boolean {
  const normalized = type.toLowerCase().replaceAll("_", "-");
  const known = new Set([
    "agent-message",
    "assistant",
    "compacted",
    "error",
    "event",
    "event-msg",
    "exec-command-begin",
    "exec-command-end",
    "file-history-snapshot",
    "function-call",
    "function-call-output",
    "message",
    "model",
    "notification",
    "progress",
    "queue-operation",
    "reasoning",
    "request",
    "response",
    "response-item",
    "result",
    "session",
    "session-end",
    "session-meta",
    "session-start",
    "summary",
    "system",
    "tool",
    "tool-call",
    "tool-result",
    "tool-use",
    "turn",
    "turn-context",
    "turn-end",
    "turn-start",
    "usage",
    "user",
    "user-message",
  ]);
  if (known.has(normalized)) return true;
  if (agent === "kimi-code" && normalized.startsWith("session.")) return true;
  if (agent === "chatgpt-codex" && record.type === "response_item") return true;
  return Boolean(message?.role || payload?.message);
}

function observationType(type: string, body: unknown): HistoryEvent["type"] {
  const normalized = type.toLowerCase().replaceAll("_", "-");
  if (
    normalized.includes("tool") ||
    normalized.includes("exec-command") ||
    normalized.includes("function-call")
  ) {
    return "tool";
  }
  if (
    normalized.includes("session-start") ||
    normalized.includes("turn-start") ||
    normalized === "agent"
  ) {
    return "agent";
  }
  if (normalized.includes("assistant") || normalized.includes("message")) {
    const record = asRecord(body);
    if (record?.model || record?.usage) return "generation";
  }
  return "event";
}

function inputFor(type: string, body: unknown): unknown {
  const normalized = type.toLowerCase().replaceAll("_", "-");
  if (
    normalized.includes("assistant") ||
    normalized.includes("agent-message") ||
    normalized.includes("tool-result") ||
    normalized.includes("function-call-output") ||
    normalized === "result" ||
    normalized === "output"
  ) {
    return undefined;
  }
  return body;
}

function outputFor(type: string, body: unknown): unknown {
  const normalized = type.toLowerCase().replaceAll("_", "-");
  if (
    normalized.includes("assistant") ||
    normalized.includes("agent-message") ||
    normalized.includes("tool-result") ||
    normalized.includes("function-call-output") ||
    normalized === "result" ||
    normalized === "output"
  ) {
    return body;
  }
  return undefined;
}

function normalizeUsage(value: unknown): Record<string, number> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const entries = Object.entries(usage).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function contentId(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function stableKey(parts: string[]): string {
  return JSON.stringify(parts);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}
