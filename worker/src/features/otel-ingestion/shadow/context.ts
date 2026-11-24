import { createHash } from "node:crypto";
import { stableJsonStringify } from "@langfuse/shared";
import {
  findModelInPostgres,
  findPricingTiersForModel,
} from "@langfuse/shared/src/server";
import type { OtelProcessingHooks } from "../processingHooks";
import { mediaHooks } from "./media";
import { schedulingHooks } from "./eval";
import { getShadowWriter } from "./writer";
import type { OtelShadowRowLocator } from "./rowKey";

type Effect = {
  primary: number;
  native: number;
  results: { value: unknown }[];
};
type Comparison = { effects?: Map<string, Map<string, Effect>> };
type Receipt = { status: "inserted" | "dropped" };

const readOnlyLookups = {
  redis: null,
  async findModel(params: Parameters<typeof findModelInPostgres>[0]) {
    const model = await findModelInPostgres(params);
    return {
      model,
      pricingTiers: model ? await findPricingTiersForModel(model.id) : [],
    };
  },
} satisfies NonNullable<OtelProcessingHooks["lookups"]>;

export class ShadowScope implements OtelProcessingHooks {
  readonly media;
  readonly scheduling;
  readonly getNativeWriter;
  readonly lookups;
  readonly recordIngestionMetrics;
  readonly onFailure = (stage: string) => this.fail(stage);
  readonly effects;
  readonly failures: Record<string, number> = {};
  readonly rows: OtelShadowRowLocator[] = [];
  private pending = 0;
  private dropped = false;
  private drained?: () => void;

  constructor(
    readonly side: "primary" | "native",
    readonly sample: Comparison,
  ) {
    if (!sample.effects)
      sample.effects = new Map<string, Map<string, Effect>>();
    this.effects = sample.effects;
    this.media = mediaHooks(this);
    this.scheduling = schedulingHooks(this);
    this.getNativeWriter = side === "native" ? getShadowWriter : undefined;
    this.lookups = side === "native" ? readOnlyLookups : undefined;
    this.recordIngestionMetrics = side !== "native";
  }

  private occurrence(kind: string, identity: unknown) {
    try {
      const digest = createHash("sha256")
        .update(stableJsonStringify(identity))
        .digest("base64");
      const group = this.effects.get(kind) ?? new Map<string, Effect>();
      const entry = group.get(digest) ?? { primary: 0, native: 0, results: [] };
      group.set(digest, entry);
      this.effects.set(kind, group);
      return { entry, index: entry[this.side]++ };
    } catch {
      this.fail("capture");
    }
  }

  record(kind: string, identity: unknown) {
    this.occurrence(kind, identity);
  }

  /** Identical requests replay in invocation order, even when uploads finish out of order. */
  async effect<T>(
    kind: string,
    identity: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const occurrence = this.occurrence(kind, identity);
    if (this.side === "primary") {
      try {
        const value = await run();
        if (occurrence) occurrence.entry.results[occurrence.index] = { value };
        return value;
      } catch (error) {
        this.fail(kind);
        throw error;
      }
    }
    const observed = occurrence?.entry.results[occurrence.index];
    if (observed) return observed.value as T;
    this.fail(
      occurrence && occurrence.index < occurrence.entry.primary
        ? kind
        : "missing_effect",
    );
    throw new Error("No successful primary result for this operation");
  }

  fail(stage: string) {
    this.failures[stage] = (this.failures[stage] ?? 0) + 1;
  }

  readonly observeWrite = (
    row: OtelShadowRowLocator,
    enqueue: (onTerminal: (receipt: Receipt) => void) => void,
  ) => {
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
  };

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

export function effectDifferences(primary: ShadowScope) {
  const differences = [];
  for (const [kind, group] of primary.effects) {
    let missing = 0;
    let extra = 0;
    for (const { primary, native } of group.values()) {
      missing += Math.max(0, primary - native);
      extra += Math.max(0, native - primary);
    }
    if (missing || extra) differences.push({ kind, missing, extra });
  }
  return differences;
}
