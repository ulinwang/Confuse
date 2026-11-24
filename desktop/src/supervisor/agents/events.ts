import { createHash } from "node:crypto";
import type { AgentKind } from "../../shared/contracts";
import type {
  LangfuseIngestionEvent,
  LangfuseObservationBody,
  LangfuseUsage,
} from "./types";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function identifier(value: unknown): string | number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : string(value);
}

function stableId(...parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
}

function eventTimestamp(
  payload: JsonRecord,
  envelope: JsonRecord | undefined,
  now: Date,
): string {
  const candidate =
    string(payload.timestamp) ??
    string(payload.created_at) ??
    string(envelope?.sentAt) ??
    (typeof payload.time === "number"
      ? new Date(payload.time).toISOString()
      : undefined);
  if (candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }
  return now.toISOString();
}

function usage(value: unknown): LangfuseUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const input =
    number(source.input) ??
    number(source.input_tokens) ??
    number(source.prompt_tokens) ??
    number(source.inputTokens);
  const output =
    number(source.output) ??
    number(source.output_tokens) ??
    number(source.completion_tokens) ??
    number(source.outputTokens);
  const total =
    number(source.total) ??
    number(source.total_tokens) ??
    number(source.totalTokens);
  if (input === undefined && output === undefined && total === undefined)
    return undefined;
  return {
    unit: "TOKENS",
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
  };
}

interface NormalizedShape {
  eventName: string;
  sessionId: string;
  turnId?: string | number;
  eventId?: string | number;
  itemId?: string | number;
  model?: string;
  formatVersion?: string | number;
  input?: unknown;
  output?: unknown;
  usage?: LangfuseUsage;
  level?: "DEFAULT" | "ERROR";
  statusMessage?: string;
  observationType?: "span" | "generation" | "event";
  observationName?: string;
  end?: boolean;
}

function normalizeDsh(payload: JsonRecord): JsonRecord {
  const sourceEvent = record(payload.sourceEvent);
  const envelope = record(sourceEvent?.envelope);
  if (!sourceEvent || !envelope) return payload;
  const body = record(payload.body) ?? {};
  const attributes = record(payload.attributes);
  const formatVersion =
    identifier(attributes?.["session.format_version"]) ??
    identifier(envelope.format_version);
  const type = string(envelope.type) ?? "unknown";
  const eventName =
    {
      "turn/start": "TurnStarted",
      "turn/end": "Stop",
      "tool/start": "PreToolUse",
      "tool/result": "PostToolUse",
      "assistant/message": "PostModelRequest",
      "assistant/attempt": "PostModelRequest",
      "session/start": "SessionStart",
      "session/end": "SessionEnd",
    }[type] ?? type;
  return {
    ...body,
    hook_event_name: eventName,
    session_id: sourceEvent.sessionId,
    turn_id: envelope.turn ?? body.turn_id,
    event_id:
      formatVersion === undefined || envelope.seq === undefined
        ? envelope.seq
        : `${String(formatVersion)}:${String(envelope.seq)}`,
    event_type: type,
    format_version: formatVersion,
    model: body.model,
    tool_name: body.tool_name ?? body.name,
    tool_use_id: body.tool_call_id ?? body.call_id ?? body.id,
    token_usage: body.token_usage ?? body.usage,
    severity: payload.severity,
  };
}

function shape(payloadInput: JsonRecord): NormalizedShape | undefined {
  const payload = normalizeDsh(payloadInput);
  const sessionId = string(payload.session_id) ?? string(payload.sessionId);
  const eventName =
    string(payload.hook_event_name) ??
    string(payload.event) ??
    string(payload.type);
  if (!sessionId || !eventName) return undefined;
  const eventId =
    identifier(payload.event_id) ??
    identifier(payload.eventId) ??
    identifier(payload.id);
  const turnId = identifier(payload.turn_id) ?? identifier(payload.turnId);
  const toolUseId =
    identifier(payload.tool_use_id) ?? identifier(payload.toolUseId);
  const body = record(payload.body);
  const tokenUsage =
    payload.token_usage ?? payload.usage ?? body?.token_usage ?? body?.usage;
  const error = string(payload.error) ?? string(payload.error_message);
  const severity = string(payload.severity);
  const common = {
    eventName,
    sessionId,
    eventId,
    ...(turnId === undefined ? {} : { turnId }),
    model: string(payload.model) ?? string(body?.model),
    formatVersion: identifier(payload.format_version),
    usage: usage(tokenUsage),
    level:
      severity === "error" || error !== undefined
        ? ("ERROR" as const)
        : ("DEFAULT" as const),
    ...(error === undefined ? {} : { statusMessage: error }),
  };

  switch (eventName) {
    case "SessionStart":
    case "SessionEnd":
      return common;
    case "UserPromptSubmit":
      return {
        ...common,
        itemId: turnId ?? eventId,
        input: payload.prompt ?? payload.input,
        observationType: turnId === undefined ? "event" : "span",
        observationName: turnId === undefined ? "User prompt" : "Agent turn",
      };
    case "TurnStarted":
      return {
        ...common,
        itemId: turnId ?? eventId,
        input: payload.prompt ?? payload.input,
        observationType: "span",
        observationName: "Agent turn",
      };
    case "PreToolUse":
      return {
        ...common,
        itemId: toolUseId ?? eventId,
        input: payload.tool_input ?? payload.input,
        observationType: "span",
        observationName: string(payload.tool_name) ?? "Tool call",
      };
    case "PostToolUse":
    case "PostToolUseFailure":
      return {
        ...common,
        itemId: toolUseId ?? eventId,
        input: payload.tool_input ?? payload.input,
        output: payload.tool_response ?? payload.output,
        observationType: "span",
        observationName: string(payload.tool_name) ?? "Tool call",
        end: true,
        level: eventName === "PostToolUseFailure" ? "ERROR" : common.level,
      };
    case "PostModelRequest":
    case "Stop":
    case "StopFailure":
      return {
        ...common,
        itemId: turnId ?? eventId,
        output: payload.last_assistant_message ?? payload.output,
        observationType: "generation",
        observationName:
          eventName === "Stop" ? "Agent response" : "Model request",
        end: true,
        level: eventName === "StopFailure" ? "ERROR" : common.level,
      };
    default:
      return {
        ...common,
        itemId: eventId ?? turnId,
        input: payload.input ?? payload.message ?? body,
        observationType: "event",
        observationName: eventName,
      };
  }
}

export function normalizeAgentEvent(
  kind: AgentKind,
  input: unknown,
  now = new Date(),
): LangfuseIngestionEvent[] {
  const outer = record(input);
  if (!outer) return [];
  const wrappedPayload = record(outer.payload);
  const payload =
    wrappedPayload && outer.agent === kind ? wrappedPayload : outer;
  const normalized = shape(payload);
  if (!normalized) return [];
  const timestamp = eventTimestamp(
    payload,
    outer === payload ? undefined : outer,
    now,
  );
  const sourceEventId =
    normalized.eventId ??
    normalized.itemId ??
    identifier(payload.id) ??
    stableId(payload, normalized.eventName);
  const sourceItemId =
    normalized.itemId ??
    normalized.eventId ??
    identifier(payload.id) ??
    stableId(payload, normalized.eventName);
  const workspace = kind === "kimi-code" ? string(payload.cwd) : undefined;
  const traceId = stableId(kind, "session", workspace, normalized.sessionId);
  const observationId = stableId(
    kind,
    workspace,
    normalized.sessionId,
    normalized.observationType ?? "trace",
    normalized.observationName ?? normalized.eventName,
    normalized.turnId,
    sourceItemId,
  );
  const parentObservationId =
    normalized.turnId && normalized.observationName !== "Agent turn"
      ? stableId(
          kind,
          workspace,
          normalized.sessionId,
          "span",
          "Agent turn",
          normalized.turnId,
          normalized.turnId,
        )
      : undefined;
  const metadata = {
    agent: kind,
    source: "confuse-desktop-agent",
    hookEvent: normalized.eventName,
    sessionId: normalized.sessionId,
    ...(string(payload.cwd) === undefined ? {} : { cwd: payload.cwd }),
    ...(normalized.turnId === undefined ? {} : { turnId: normalized.turnId }),
    ...(normalized.model === undefined ? {} : { model: normalized.model }),
    ...(normalized.formatVersion === undefined
      ? {}
      : { formatVersion: normalized.formatVersion }),
    sourceEventId,
  };
  const trace: LangfuseIngestionEvent = {
    id: stableId(
      kind,
      "trace-event",
      normalized.sessionId,
      normalized.eventName,
      sourceEventId,
    ),
    type: "trace-create",
    timestamp,
    body: {
      id: traceId,
      name: `${kind} session`,
      sessionId: normalized.sessionId,
      timestamp,
      ...(normalized.eventName === "UserPromptSubmit" &&
      normalized.input !== undefined
        ? { input: normalized.input }
        : {}),
      ...((normalized.eventName === "Stop" ||
        normalized.eventName === "SessionEnd") &&
      normalized.output !== undefined
        ? { output: normalized.output }
        : {}),
      metadata,
    },
  };
  if (!normalized.observationType) return [trace];

  const body: LangfuseObservationBody = {
    id: observationId,
    traceId,
    ...(parentObservationId === undefined ? {} : { parentObservationId }),
    name: normalized.observationName ?? normalized.eventName,
    startTime: timestamp,
    ...(normalized.end ? { endTime: timestamp } : {}),
    ...(normalized.input === undefined ? {} : { input: normalized.input }),
    ...(normalized.output === undefined ? {} : { output: normalized.output }),
    ...(normalized.model === undefined ? {} : { model: normalized.model }),
    ...(normalized.usage === undefined ? {} : { usage: normalized.usage }),
    level: normalized.level ?? "DEFAULT",
    ...(normalized.statusMessage === undefined
      ? {}
      : { statusMessage: normalized.statusMessage }),
    metadata,
  };
  return [
    trace,
    {
      id: stableId(
        kind,
        "observation-event",
        normalized.sessionId,
        normalized.eventName,
        sourceEventId,
      ),
      type: `${normalized.observationType}-create`,
      timestamp,
      body,
    },
  ];
}
