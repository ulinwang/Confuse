import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { stableJsonStringify } from "@langfuse/shared";
import type { OtelShadowRowLocator } from "./rowKey";

type Receipt = { status: "inserted" | "dropped" };

// Scope the observers to the direct OTEL call. Concurrent jobs and legacy
// writes in the same batch continue to use their normal dependencies.
export const otelShadowScope = new AsyncLocalStorage<ShadowScope | undefined>();

export class ShadowScope {
  readonly effects = new Map<string, Map<string, number>>();
  readonly failures: Record<string, number> = {};
  readonly rows: OtelShadowRowLocator[] = [];
  private pending = 0;
  private dropped = false;
  private drained?: () => void;

  constructor(
    readonly side: "primary" | "native",
    readonly sample: object,
  ) {}

  record(kind: string, identity: unknown) {
    try {
      const digest = createHash("sha256")
        .update(stableJsonStringify(identity))
        .digest("base64");
      const counts = this.effects.get(kind) ?? new Map<string, number>();
      counts.set(digest, (counts.get(digest) ?? 0) + 1);
      this.effects.set(kind, counts);
    } catch {
      this.fail("capture");
    }
  }

  fail(stage: string) {
    this.failures[stage] = (this.failures[stage] ?? 0) + 1;
  }

  track(
    row: OtelShadowRowLocator,
    enqueue: (onTerminal: (receipt: Receipt) => void) => void,
  ) {
    this.pending++;
    const done = () => {
      if (--this.pending === 0) this.drained?.();
    };
    try {
      enqueue(({ status }) => {
        if (status === "inserted") this.rows.push(row);
        else this.dropped = true;
        done();
      });
    } catch (error) {
      done();
      this.fail("row_write");
      throw error;
    }
  }

  // Call after the processor returns or throws. Its earlier enqueues can still
  // be waiting for the writer's interval flush, split retry, or final drop.
  async settle() {
    if (this.pending > 0)
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    if (this.dropped) return "dropped";
    return this.rows.length > 0 ? "inserted" : "empty";
  }
}

export function effectDifferences(primary: ShadowScope, native: ShadowScope) {
  const differences = [];
  for (const kind of new Set([
    ...primary.effects.keys(),
    ...native.effects.keys(),
  ])) {
    const left = primary.effects.get(kind);
    const right = native.effects.get(kind);
    let missing = 0;
    let extra = 0;
    for (const key of new Set([
      ...(left?.keys() ?? []),
      ...(right?.keys() ?? []),
    ])) {
      const delta = (right?.get(key) ?? 0) - (left?.get(key) ?? 0);
      if (delta > 0) extra += delta;
      else missing -= delta;
    }
    if (missing || extra) differences.push({ kind, missing, extra });
  }
  return differences;
}
