import type { OutboxRecord, DesktopStore } from "./store";

export interface OutboxDispatcher {
  (record: OutboxRecord): Promise<void>;
}

export class OutboxWorker {
  private dispatcher?: OutboxDispatcher;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly store: DesktopStore,
    private readonly pollMs: number,
    private readonly onError?: (record: OutboxRecord, error: Error) => void,
  ) {}

  setDispatcher(dispatcher: OutboxDispatcher): void {
    this.dispatcher = dispatcher;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.flush(), this.pollMs);
    this.timer.unref();
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.flushDue().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async flushDue(): Promise<void> {
    if (!this.dispatcher || this.stopped) return;
    for (const record of this.store.dueOutbox()) {
      if (this.stopped) break;
      try {
        await this.dispatcher(record);
        this.store.deleteOutbox(record.id);
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("Outbox delivery failed");
        const delay = Math.min(
          300_000,
          1_000 * 2 ** Math.min(record.attempts, 8),
        );
        this.store.failOutbox(
          record.id,
          error.name,
          new Date(Date.now() + delay).toISOString(),
        );
        if (
          record.attempts === 0 ||
          record.attempts === 4 ||
          record.attempts === 19
        ) {
          this.onError?.(record, error);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
