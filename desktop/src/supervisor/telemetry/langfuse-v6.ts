import { createHash } from "node:crypto";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startObservation,
} from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TelemetryDelivery, TelemetryEvent } from "./types.js";

interface LangfuseV6Observation {
  end(endTime?: Date): void;
}

export interface LangfuseV6Client {
  setObservationIds(traceId: string, observationId: string): void;
  propagateAttributes<T>(
    attributes: {
      traceName: string;
      sessionId: string;
      userId?: string;
      metadata?: Record<string, unknown>;
    },
    callback: () => T,
  ): T;
  startObservation(
    name: string,
    attributes: {
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
      model?: string;
      usageDetails?: Record<string, number>;
    },
    options: {
      asType: TelemetryEvent["type"];
      startTime?: Date;
      parentSpanContext: {
        traceId: string;
        spanId: string;
        traceFlags: number;
        isRemote: boolean;
      };
    },
  ): LangfuseV6Observation;
  forceFlush(): Promise<void>;
  shutdown?(): Promise<void>;
}

export class LangfuseV6Delivery implements TelemetryDelivery {
  constructor(private readonly client: LangfuseV6Client) {}

  async deliver(event: TelemetryEvent, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.client.setObservationIds(event.traceId, event.observationId);
    const startTime = parseTimestamp(event.timestamp);
    const parentSpanContext = {
      traceId: event.traceId,
      spanId: event.parentObservationId ?? rootObservationId(event.traceId),
      traceFlags: 1,
      isRemote: true,
    };

    this.client.propagateAttributes(
      {
        traceName: `${event.agent} session`,
        sessionId: event.sessionId,
        userId: event.userId,
        metadata: {
          agent: event.agent,
          historical: event.metadata?.historical === true,
        },
      },
      () => {
        const observation = this.client.startObservation(
          event.name,
          {
            input: event.input,
            output: event.output,
            metadata: event.metadata,
            model: event.model,
            usageDetails: event.usageDetails,
          },
          {
            asType: event.type,
            startTime,
            parentSpanContext,
          },
        );
        if (event.type !== "event") {
          observation.end(parseTimestamp(event.endTimestamp) ?? startTime);
        }
      },
    );

    throwIfAborted(signal);
    await this.client.forceFlush();
    throwIfAborted(signal);
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown?.();
  }
}

export interface NodeLangfuseV6Options {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment?: string;
}

export function createNodeLangfuseV6Client(
  options: NodeLangfuseV6Options,
): LangfuseV6Client {
  const baseUrl = validateLocalLangfuseBaseUrl(options.baseUrl);
  const ids = new DeterministicIdGenerator();
  const processor = new LangfuseSpanProcessor({
    baseUrl,
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    environment: options.environment,
    mediaUploadEnabled: false,
    shouldExportSpan: () => true,
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
    idGenerator: ids,
  });
  setLangfuseTracerProvider(provider);

  return {
    setObservationIds: (traceId, observationId) =>
      ids.set(traceId, observationId),
    propagateAttributes: (attributes, callback) =>
      propagateAttributes(attributes, callback),
    startObservation: (name, attributes, observationOptions) =>
      startObservation(name, attributes, observationOptions as never),
    forceFlush: () => processor.forceFlush(),
    shutdown: async () => {
      try {
        await provider.shutdown();
      } finally {
        setLangfuseTracerProvider(null);
      }
    },
  };
}

export function validateLocalLangfuseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Langfuse base URL is invalid");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Langfuse base URL must be a local Confuse origin without credentials",
    );
  }
  return url.origin;
}

class DeterministicIdGenerator {
  private traceId = "0".repeat(32);
  private spanId = "0".repeat(16);

  set(traceId: string, spanId: string): void {
    if (!/^[a-f0-9]{32}$/.test(traceId) || !/^[a-f0-9]{16}$/.test(spanId)) {
      throw new Error("Invalid deterministic OpenTelemetry ID");
    }
    this.traceId = traceId;
    this.spanId = spanId;
  }

  generateTraceId(): string {
    return this.traceId;
  }

  generateSpanId(): string {
    return this.spanId;
  }
}

function rootObservationId(traceId: string): string {
  return createHash("sha256")
    .update(`confuse:root:${traceId}`)
    .digest("hex")
    .slice(0, 16);
}

function parseTimestamp(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("Telemetry delivery cancelled", "AbortError");
}
