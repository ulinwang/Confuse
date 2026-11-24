import { describe, expect, it } from "vitest";
import { TelemetryOutbox } from "./outbox.js";
import type {
  OutboxEntry,
  OutboxRetryUpdate,
  OutboxStore,
  TelemetryDelivery,
  TelemetryEvent,
} from "./types.js";

describe("TelemetryOutbox", () => {
  it("persists retry backoff and delivers after a worker restart", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryOutboxStore();
    const event = telemetryEvent();
    const failing: TelemetryDelivery = {
      deliver: async () => {
        throw new Error("offline sk-lf-synthetic-secret");
      },
    };
    const firstWorker = new TelemetryOutbox({
      store,
      delivery: failing,
      now: () => now,
    });
    expect(await firstWorker.enqueue(event)).toBe(true);
    expect(await firstWorker.enqueue(event)).toBe(false);

    const failed = await firstWorker.drain();
    expect(failed).toMatchObject({ delivered: 0, failed: 1, remaining: 1 });
    expect(store.entries.get(event.id)).toMatchObject({
      attempts: 1,
      nextAttemptAt: "2026-01-01T00:00:01.000Z",
      lastError: "offline [redacted]",
    });

    const secondWorker = new TelemetryOutbox({
      store,
      delivery: { deliver: async () => undefined },
      now: () => now,
    });
    expect((await secondWorker.drain()).delivered).toBe(0);
    now = new Date("2026-01-01T00:00:01.000Z");
    expect(await secondWorker.drain()).toMatchObject({
      delivered: 1,
      remaining: 0,
    });
    expect(store.entries.size).toBe(0);
  });

  it("leaves an entry pending on cancellation and resumes it", async () => {
    const store = new MemoryOutboxStore();
    const controller = new AbortController();
    const event = telemetryEvent();
    const cancelling: TelemetryDelivery = {
      deliver: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    };
    const worker = new TelemetryOutbox({ store, delivery: cancelling });
    await worker.enqueue(event);

    expect(await worker.drain({ signal: controller.signal })).toMatchObject({
      delivered: 0,
      failed: 0,
      cancelled: true,
      remaining: 1,
    });
    expect(store.entries.get(event.id)?.attempts).toBe(0);

    const resumed = new TelemetryOutbox({
      store,
      delivery: { deliver: async () => undefined },
    });
    expect(await resumed.drain()).toMatchObject({ delivered: 1, remaining: 0 });
  });
});

class MemoryOutboxStore implements OutboxStore {
  readonly entries = new Map<string, OutboxEntry>();

  async putIfAbsent(entry: OutboxEntry): Promise<boolean> {
    if (this.entries.has(entry.id)) return false;
    this.entries.set(entry.id, structuredClone(entry));
    return true;
  }

  async listReady(now: string, limit: number): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.nextAttemptAt <= now)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async markDelivered(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async markRetry(id: string, update: OutboxRetryUpdate): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) this.entries.set(id, { ...entry, ...update });
  }

  async countPending(): Promise<number> {
    return this.entries.size;
  }
}

function telemetryEvent(): TelemetryEvent {
  return {
    id: "event-id",
    traceId: "1".repeat(32),
    observationId: "2".repeat(16),
    agent: "kimi-code",
    sessionId: "session",
    name: "synthetic",
    type: "event",
    input: { synthetic: true },
  };
}
