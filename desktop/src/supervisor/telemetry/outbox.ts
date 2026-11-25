import type {
  OutboxDrainResult,
  OutboxStore,
  TelemetryDelivery,
  TelemetryEvent,
} from "./types.js";

export interface TelemetryOutboxOptions {
  store: OutboxStore;
  delivery: TelemetryDelivery;
  now?: () => Date;
  retryDelayMs?: (attempt: number) => number;
}

export interface OutboxDrainOptions {
  signal?: AbortSignal;
  batchSize?: number;
  maxEntries?: number;
}

export class TelemetryOutbox {
  private readonly store: OutboxStore;
  private readonly delivery: TelemetryDelivery;
  private readonly now: () => Date;
  private readonly retryDelayMs: (attempt: number) => number;
  private activeDrain?: Promise<OutboxDrainResult>;

  constructor(options: TelemetryOutboxOptions) {
    this.store = options.store;
    this.delivery = options.delivery;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  }

  async enqueue(event: TelemetryEvent): Promise<boolean> {
    const now = this.now().toISOString();
    return this.store.putIfAbsent({
      id: event.id,
      event,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    });
  }

  drain(options: OutboxDrainOptions = {}): Promise<OutboxDrainResult> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.performDrain(options).finally(() => {
      this.activeDrain = undefined;
    });
    this.activeDrain = drain;
    return drain;
  }

  private async performDrain(
    options: OutboxDrainOptions,
  ): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = {
      delivered: 0,
      failed: 0,
      cancelled: false,
      remaining: 0,
    };
    const batchSize = positiveInteger(options.batchSize, 100);
    const maxEntries = positiveInteger(
      options.maxEntries,
      Number.MAX_SAFE_INTEGER,
    );
    let processed = 0;

    while (processed < maxEntries && !options.signal?.aborted) {
      const entries = await this.store.listReady(
        this.now().toISOString(),
        batchSize,
      );
      if (entries.length === 0) break;

      for (const entry of entries) {
        if (processed >= maxEntries || options.signal?.aborted) {
          result.cancelled = options.signal?.aborted ?? false;
          break;
        }
        processed += 1;
        try {
          await this.delivery.deliver(entry.event, options.signal);
          await this.store.markDelivered(entry.id);
          result.delivered += 1;
        } catch (error) {
          if (options.signal?.aborted || isAbortError(error)) {
            result.cancelled = true;
            break;
          }
          const attempts = entry.attempts + 1;
          const now = this.now();
          await this.store.markRetry(entry.id, {
            attempts,
            updatedAt: now.toISOString(),
            nextAttemptAt: new Date(
              now.getTime() + this.retryDelayMs(attempts),
            ).toISOString(),
            lastError: sanitizeError(error),
          });
          result.failed += 1;
        }
      }
    }

    result.cancelled ||= options.signal?.aborted ?? false;
    result.remaining = await this.store.countPending();
    return result;
  }
}

function defaultRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(exponent, 20));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(?:sk|pk)-lf-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .slice(0, 500);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
