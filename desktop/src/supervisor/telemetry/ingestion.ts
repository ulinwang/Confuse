import { createHash } from "node:crypto";
import type { AgentKind } from "../../shared/contracts";
import type { LangfuseIngestionEvent, LangfuseUsage } from "../agents/types";
import type { TelemetryEvent } from "./types";

export function ingestionToTelemetry(
  agent: AgentKind,
  event: LangfuseIngestionEvent,
): TelemetryEvent {
  const common = {
    id: event.id,
    agent,
    sessionId: ingestionSessionId(event),
    name: event.body.name,
    timestamp: event.timestamp,
    input: event.body.input,
    output: event.body.output,
    metadata: {
      ...event.body.metadata,
      historical: false,
      ingestionEventId: event.id,
      ingestionEventType: event.type,
    },
  };
  if (event.type === "trace-create") {
    return {
      ...common,
      traceId: event.body.id,
      observationId: deterministicHex(event.body.id, 16),
      userId: event.body.userId,
      type: "agent",
      timestamp: event.body.timestamp,
    };
  }

  return {
    ...common,
    traceId: event.body.traceId,
    observationId: deterministicHex(event.body.id, 16),
    ...(event.body.parentObservationId === undefined
      ? {}
      : {
          parentObservationId: deterministicHex(
            event.body.parentObservationId,
            16,
          ),
        }),
    type: observationType(event.type),
    timestamp: event.body.startTime,
    endTimestamp: event.body.endTime,
    model: event.body.model,
    usageDetails: usageDetails(event.body.usage),
  };
}

function ingestionSessionId(event: LangfuseIngestionEvent): string {
  const sessionId =
    event.type === "trace-create"
      ? event.body.sessionId
      : event.body.metadata.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Normalized Agent event is missing its session ID");
  }
  return sessionId;
}

function observationType(
  type: "span-create" | "generation-create" | "event-create",
): TelemetryEvent["type"] {
  switch (type) {
    case "span-create":
      return "span";
    case "generation-create":
      return "generation";
    case "event-create":
      return "event";
  }
}

function usageDetails(
  usage: LangfuseUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  return Object.fromEntries(
    [
      ["input", usage.input],
      ["output", usage.output],
      ["total", usage.total],
    ].filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function deterministicHex(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}
