import { createHash } from "node:crypto";
import type { AgentKind, HistoryPreview } from "../../shared/contracts.js";
import type { OutboxEntry, TelemetryEvent } from "../telemetry/types.js";
import { readJsonlIncrementally } from "./jsonl-reader.js";
import { parseDshHistoryEvent, parseJsonlHistoryEvent } from "./parsers.js";
import type {
  DshCursor,
  DshHistorySource,
  DshSessionEvent,
  HistoryEvent,
  HistoryImportOptions,
  HistoryImportResult,
  HistoryServiceOptions,
  HistorySource,
  JsonlHistorySource,
} from "./types.js";

export class HistoryService {
  private readonly sources: readonly HistorySource[];
  private readonly store: HistoryServiceOptions["store"];
  private readonly outbox: HistoryServiceOptions["outbox"];
  private readonly now: () => Date;
  private readonly cursorNamespace?: string;

  constructor(options: HistoryServiceOptions) {
    this.sources = options.sources;
    this.store = options.store;
    this.outbox = options.outbox;
    this.now = options.now ?? (() => new Date());
    this.cursorNamespace = options.cursorNamespace;
  }

  private cursorId(sourceId: string): string {
    return this.cursorNamespace
      ? `${this.cursorNamespace}:${sourceId}`
      : sourceId;
  }

  async preview(kinds: AgentKind[]): Promise<HistoryPreview[]> {
    return Promise.all(kinds.map((kind) => this.previewKind(kind)));
  }

  async import(
    kinds: AgentKind[],
    options: HistoryImportOptions = {},
  ): Promise<HistoryImportResult[]> {
    const results: HistoryImportResult[] = [];
    for (const kind of kinds) {
      const result = emptyResult(kind);
      const sources = this.sources.filter((source) => source.agent === kind);
      if (sources.length === 0) {
        result.warnings.push("No authorized history sources");
        result.state = "failed";
        results.push(result);
        continue;
      }

      let sourceFailures = 0;
      for (const source of sources) {
        if (options.signal?.aborted) {
          result.state = "cancelled";
          break;
        }
        try {
          if (source.kind === "jsonl") {
            await this.importJsonl(source, result, options);
          } else {
            await this.importDsh(source, result, options);
          }
        } catch (error) {
          if (isAbortError(error) || options.signal?.aborted) {
            result.state = "cancelled";
            break;
          }
          sourceFailures += 1;
          result.warnings.push(`Source ${source.id}: ${errorMessage(error)}`);
        }
      }

      if (result.state !== "cancelled") {
        result.state =
          sourceFailures > 0 && result.scanned === 0
            ? "failed"
            : sourceFailures > 0 || result.malformed > 0
              ? "partially-succeeded"
              : "succeeded";
      }
      options.onProgress?.({ ...result, warnings: [...result.warnings] });
      results.push(result);
      if (result.state === "cancelled") break;
    }
    return results;
  }

  async recordWatermarks(
    kinds: AgentKind[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const kind of kinds) {
      for (const source of this.sources.filter(
        (candidate) => candidate.agent === kind,
      )) {
        if (source.kind === "jsonl") {
          const cursor = await this.store.getCursor(this.cursorId(source.id));
          const result = await readJsonlIncrementally({
            source,
            cursor: cursor?.kind === "jsonl" ? cursor : undefined,
            signal,
            onLine: async ({ cursor: nextCursor }) => {
              await this.store.saveCursor(this.cursorId(source.id), nextCursor);
            },
          });
          await this.store.saveCursor(this.cursorId(source.id), result.cursor);
        } else {
          const stored = await this.store.getCursor(this.cursorId(source.id));
          const cursor =
            stored?.kind === "dsh" &&
            stored.sessionId === source.sessionId &&
            stored.formatVersion === source.formatVersion
              ? stored
              : undefined;
          await this.readDsh(
            source,
            cursor,
            signal,
            async (_event, nextCursor) => {
              await this.store.saveCursor(this.cursorId(source.id), nextCursor);
            },
          );
        }
      }
    }
  }

  private async importJsonl(
    source: JsonlHistorySource,
    result: HistoryImportResult,
    options: HistoryImportOptions,
  ): Promise<void> {
    const stored = await this.store.getCursor(this.cursorId(source.id));
    const read = await readJsonlIncrementally({
      source,
      cursor: stored?.kind === "jsonl" ? stored : undefined,
      signal: options.signal,
      onLine: async ({ text, cursor }) => {
        result.scanned += 1;
        let event: HistoryEvent | undefined;
        let malformed = false;
        try {
          event = parseJsonlHistoryEvent(source.agent, text, {
            sourceId: source.id,
            sessionId: source.sessionId,
            workspaceId: source.workspaceId,
            rolloutId: source.rolloutId,
            transcriptId: source.transcriptId,
          });
        } catch {
          malformed = true;
          result.malformed += 1;
        }

        if (event) {
          const inserted = await this.enqueue(event);
          if (inserted) result.enqueued += 1;
          else result.duplicates += 1;
        } else if (!malformed && text.trim().length > 0) {
          result.skipped += 1;
        }
        await this.store.saveCursor(this.cursorId(source.id), cursor);
      },
    });
    await this.store.saveCursor(this.cursorId(source.id), read.cursor);
  }

  private async importDsh(
    source: DshHistorySource,
    result: HistoryImportResult,
    options: HistoryImportOptions,
  ): Promise<void> {
    const stored = await this.store.getCursor(this.cursorId(source.id));
    const cursor =
      stored?.kind === "dsh" &&
      stored.sessionId === source.sessionId &&
      stored.formatVersion === source.formatVersion
        ? stored
        : undefined;

    await this.readDsh(
      source,
      cursor,
      options.signal,
      async (event, nextCursor) => {
        result.scanned += 1;
        if (!event.type.trim()) {
          result.skipped += 1;
        } else {
          const inserted = await this.enqueue(parseDshHistoryEvent(event));
          if (inserted) result.enqueued += 1;
          else result.duplicates += 1;
        }
        await this.store.saveCursor(this.cursorId(source.id), nextCursor);
      },
    );
  }

  private async readDsh(
    source: DshHistorySource,
    cursor: DshCursor | undefined,
    signal: AbortSignal | undefined,
    onEvent: (event: DshSessionEvent, cursor: DshCursor) => Promise<void>,
  ): Promise<void> {
    let lastSeq = cursor?.lastSeq;
    for await (const event of source.reader.readEvents({
      sessionId: source.sessionId,
      formatVersion: source.formatVersion,
      afterSeq: lastSeq,
      signal,
    })) {
      throwIfAborted(signal);
      if (
        event.sessionId !== source.sessionId ||
        event.formatVersion !== source.formatVersion
      ) {
        continue;
      }
      let seq: bigint;
      try {
        seq = BigInt(event.seq);
      } catch {
        continue;
      }
      if (seq < 0 || (lastSeq !== undefined && seq <= BigInt(lastSeq)))
        continue;
      const nextCursor: DshCursor = {
        kind: "dsh",
        sessionId: source.sessionId,
        formatVersion: source.formatVersion,
        lastSeq: String(seq),
      };
      await onEvent(event, nextCursor);
      lastSeq = nextCursor.lastSeq;
    }
  }

  private async previewKind(kind: AgentKind): Promise<HistoryPreview> {
    const preview: HistoryPreview = {
      kind,
      sessionCount: 0,
      includes: [],
      warnings: [],
    };
    const sessions = new Set<string>();
    const includes = new Set<string>();
    let oldest: string | undefined;
    let newest: string | undefined;
    let malformed = 0;
    let skipped = 0;

    const include = (event: HistoryEvent) => {
      sessions.add(event.sessionId);
      includes.add(event.name);
      if (event.timestamp) {
        if (!oldest || event.timestamp < oldest) oldest = event.timestamp;
        if (!newest || event.timestamp > newest) newest = event.timestamp;
      }
    };

    for (const source of this.sources.filter(
      (candidate) => candidate.agent === kind,
    )) {
      try {
        if (source.kind === "jsonl") {
          await readJsonlIncrementally({
            source,
            onLine: async ({ text }) => {
              try {
                const event = parseJsonlHistoryEvent(source.agent, text, {
                  sourceId: source.id,
                  sessionId: source.sessionId,
                  workspaceId: source.workspaceId,
                  rolloutId: source.rolloutId,
                  transcriptId: source.transcriptId,
                });
                if (event) include(event);
                else if (text.trim()) skipped += 1;
              } catch {
                malformed += 1;
              }
            },
          });
        } else {
          await this.readDsh(source, undefined, undefined, async (event) => {
            if (event.type.trim()) include(parseDshHistoryEvent(event));
            else skipped += 1;
          });
        }
      } catch (error) {
        preview.warnings.push(`Source ${source.id}: ${errorMessage(error)}`);
      }
    }

    if (this.sources.every((source) => source.agent !== kind)) {
      preview.warnings.push("No authorized history sources");
    }
    if (malformed > 0)
      preview.warnings.push(`${malformed} malformed lines skipped`);
    if (skipped > 0) preview.warnings.push(`${skipped} unknown events skipped`);
    preview.sessionCount = sessions.size;
    preview.oldestAt = oldest;
    preview.newestAt = newest;
    preview.includes = [...includes].sort().slice(0, 30);
    return preview;
  }

  private async enqueue(event: HistoryEvent): Promise<boolean> {
    const telemetry = toTelemetryEvent(event, this.cursorNamespace);
    const now = this.now().toISOString();
    const entry: OutboxEntry = {
      id: telemetry.id,
      event: telemetry,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    return this.outbox.putIfAbsent(entry);
  }
}

function toTelemetryEvent(
  event: HistoryEvent,
  projectId?: string,
): TelemetryEvent {
  const legacyId = createHash("sha256")
    .update(`${event.agent}:${event.dedupKey}`)
    .digest("hex");
  const id = projectId
    ? createHash("sha256").update(`${projectId}:${legacyId}`).digest("hex")
    : legacyId;
  return {
    id,
    traceId: deterministicHex(`${event.agent}:${event.sessionId}`, 32),
    observationId: deterministicHex(id, 16),
    agent: event.agent,
    sessionId: event.sessionId,
    name: `${event.agent}:${event.name}`,
    type: event.type,
    timestamp: event.timestamp,
    input: event.input,
    output: event.output,
    model: event.model,
    usageDetails: event.usageDetails,
    metadata: {
      ...event.metadata,
      agent: event.agent,
      historical: true,
      ...(projectId ? { projectId } : {}),
    },
  };
}

function deterministicHex(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function emptyResult(kind: AgentKind): HistoryImportResult {
  return {
    kind,
    state: "succeeded",
    scanned: 0,
    enqueued: 0,
    duplicates: 0,
    skipped: 0,
    malformed: 0,
    warnings: [],
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("History import cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}
