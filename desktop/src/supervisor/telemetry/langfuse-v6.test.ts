import { describe, expect, it } from "vitest";
import {
  LangfuseV6Delivery,
  validateLocalLangfuseBaseUrl,
  type LangfuseV6Client,
} from "./langfuse-v6.js";
import type { TelemetryEvent } from "./types.js";

describe("LangfuseV6Delivery", () => {
  it("maps stable IDs, session attributes, timestamps, and waits for flush", async () => {
    const client = new FakeLangfuseClient();
    const delivery = new LangfuseV6Delivery(client);
    const event = telemetryEvent();

    await delivery.deliver(event);
    await delivery.deliver(event);

    expect(client.ids).toEqual([
      [event.traceId, event.observationId],
      [event.traceId, event.observationId],
    ]);
    expect(client.attributes).toEqual([
      expect.objectContaining({
        sessionId: "session",
        traceName: "kimi-code session",
      }),
      expect.objectContaining({
        sessionId: "session",
        traceName: "kimi-code session",
      }),
    ]);
    expect(client.observations[0]).toMatchObject({
      name: "kimi-code:message",
      attributes: { model: "synthetic-model", output: { ok: true } },
      options: {
        asType: "generation",
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        parentSpanContext: { traceId: event.traceId },
      },
    });
    expect(client.ended).toEqual([
      new Date("2026-01-01T00:00:01.000Z"),
      new Date("2026-01-01T00:00:01.000Z"),
    ]);
    expect(client.flushes).toBe(2);
  });

  it("only allows local Confuse origins", () => {
    expect(validateLocalLangfuseBaseUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() =>
      validateLocalLangfuseBaseUrl("https://cloud.langfuse.com"),
    ).toThrow();
    expect(() =>
      validateLocalLangfuseBaseUrl("http://169.254.169.254"),
    ).toThrow();
    expect(() =>
      validateLocalLangfuseBaseUrl("http://user:pass@localhost:3000"),
    ).toThrow();
    expect(() =>
      validateLocalLangfuseBaseUrl("http://localhost:3000/other"),
    ).toThrow();
  });
});

class FakeLangfuseClient implements LangfuseV6Client {
  readonly ids: string[][] = [];
  readonly attributes: unknown[] = [];
  readonly observations: Array<{
    name: string;
    attributes: unknown;
    options: unknown;
  }> = [];
  readonly ended: Array<Date | undefined> = [];
  flushes = 0;

  setObservationIds(traceId: string, observationId: string): void {
    this.ids.push([traceId, observationId]);
  }

  propagateAttributes<T>(attributes: unknown, callback: () => T): T {
    this.attributes.push(attributes);
    return callback();
  }

  startObservation(
    name: string,
    attributes: Parameters<LangfuseV6Client["startObservation"]>[1],
    options: Parameters<LangfuseV6Client["startObservation"]>[2],
  ) {
    this.observations.push({ name, attributes, options });
    return {
      end: (endTime?: Date) => {
        this.ended.push(endTime);
      },
    };
  }

  async forceFlush(): Promise<void> {
    this.flushes += 1;
  }
}

function telemetryEvent(): TelemetryEvent {
  return {
    id: "source-event",
    traceId: "1".repeat(32),
    observationId: "2".repeat(16),
    agent: "kimi-code",
    sessionId: "session",
    name: "kimi-code:message",
    type: "generation",
    timestamp: "2026-01-01T00:00:00.000Z",
    endTimestamp: "2026-01-01T00:00:01.000Z",
    output: { ok: true },
    model: "synthetic-model",
  };
}
