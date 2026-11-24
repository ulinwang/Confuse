import type { AgentKind } from "../../shared/contracts.js";

type TelemetryObservationType =
  | "agent"
  | "event"
  | "generation"
  | "span"
  | "tool";

export interface TelemetryEvent {
  id: string;
  traceId: string;
  observationId: string;
  parentObservationId?: string;
  agent: AgentKind;
  sessionId: string;
  userId?: string;
  name: string;
  type: TelemetryObservationType;
  timestamp?: string;
  endTimestamp?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface TelemetryDelivery {
  deliver(event: TelemetryEvent, signal?: AbortSignal): Promise<void>;
}

export interface OutboxEntry {
  id: string;
  event: TelemetryEvent;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  lastError?: string;
}

export interface OutboxRetryUpdate {
  attempts: number;
  updatedAt: string;
  nextAttemptAt: string;
  lastError: string;
}

export interface OutboxStore {
  putIfAbsent(entry: OutboxEntry): Promise<boolean>;
  listReady(now: string, limit: number): Promise<OutboxEntry[]>;
  markDelivered(id: string): Promise<void>;
  markRetry(id: string, update: OutboxRetryUpdate): Promise<void>;
  countPending(): Promise<number>;
}

export interface OutboxDrainResult {
  delivered: number;
  failed: number;
  cancelled: boolean;
  remaining: number;
}
