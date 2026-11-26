import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OutboxEntry } from "../telemetry/types.js";
import { HistoryService } from "./service.js";
import type {
  DshHistorySource,
  DshSessionEvent,
  HistoryCursor,
  HistoryStore,
  JsonlHistorySource,
} from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("HistoryService", () => {
  it("previews without side effects, skips bad records, and deduplicates retries", async () => {
    const { file, source } = await jsonlFixture();
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          session_id: "s1",
          event_id: "e1",
          timestamp: "2026-01-01T00:00:00Z",
        }),
        "not-json",
        JSON.stringify({ type: "unknown", session_id: "s1", event_id: "e2" }),
        JSON.stringify({
          type: "assistant",
          session_id: "s2",
          event_id: "e3",
          timestamp: "2026-01-02T00:00:00Z",
        }),
        "",
      ].join("\n"),
    );
    const history = new MemoryHistoryStore();
    const outbox = new MemoryOutboxStore();
    const service = new HistoryService({
      sources: [source],
      store: history,
      outbox,
    });

    const [preview] = await service.preview(["kimi-code"]);
    expect(preview).toMatchObject({
      sessionCount: 2,
      oldestAt: "2026-01-01T00:00:00.000Z",
      newestAt: "2026-01-02T00:00:00.000Z",
    });
    expect(preview.warnings).toEqual([
      "1 malformed lines skipped",
      "1 unknown events skipped",
    ]);
    expect(history.cursors.size).toBe(0);
    expect(outbox.entries.size).toBe(0);

    const [imported] = await service.import(["kimi-code"]);
    expect(imported).toMatchObject({
      state: "partially-succeeded",
      scanned: 4,
      enqueued: 2,
      malformed: 1,
      skipped: 1,
    });

    const freshCursors = new MemoryHistoryStore();
    const replay = new HistoryService({
      sources: [source],
      store: freshCursors,
      outbox,
    });
    const [duplicate] = await replay.import(["kimi-code"]);
    expect(duplicate.enqueued).toBe(0);
    expect(duplicate.duplicates).toBe(2);
    expect(outbox.entries.size).toBe(2);
  });

  it("cancels after a committed event and resumes at the next complete line", async () => {
    const { file, source } = await jsonlFixture();
    await writeFile(
      file,
      '{"type":"user","session_id":"s","event_id":"e1"}\n{"type":"assistant","session_id":"s","event_id":"e2"}\n',
    );
    const history = new MemoryHistoryStore();
    const outbox = new MemoryOutboxStore();
    const controller = new AbortController();
    outbox.onPut = () => controller.abort();
    const cancelled = await new HistoryService({
      sources: [source],
      store: history,
      outbox,
    }).import(["kimi-code"], { signal: controller.signal });
    expect(cancelled[0]).toMatchObject({
      state: "cancelled",
      scanned: 1,
      enqueued: 1,
    });
    expect(history.cursors.get(source.id)?.kind).toBe("jsonl");

    outbox.onPut = undefined;
    const resumed = await new HistoryService({
      sources: [source],
      store: history,
      outbox,
    }).import(["kimi-code"]);
    expect(resumed[0]).toMatchObject({
      state: "succeeded",
      scanned: 1,
      enqueued: 1,
    });
    expect(outbox.entries.size).toBe(2);
  });

  it("reimports legacy history into a project namespace with independent cursors and IDs", async () => {
    const { file, source } = await jsonlFixture();
    await writeFile(
      file,
      '{"type":"assistant","session_id":"s1","event_id":"e1"}\n',
    );
    const history = new MemoryHistoryStore();
    const outbox = new MemoryOutboxStore();
    const legacy = new HistoryService({
      sources: [source],
      store: history,
      outbox,
    });
    await legacy.import(["kimi-code"]);
    const legacyEntry = [...outbox.entries.values()][0];

    const project = new HistoryService({
      sources: [source],
      store: history,
      outbox,
      cursorNamespace: "confuse-kimi-code",
    });
    const [migrated] = await project.import(["kimi-code"]);
    expect(migrated.enqueued).toBe(1);
    const projectEntry = [...outbox.entries.values()].find(
      (entry) => entry.id !== legacyEntry.id,
    );
    expect(projectEntry).toBeDefined();
    expect(projectEntry.event.traceId).toBe(legacyEntry.event.traceId);
    expect(projectEntry.event.metadata).toMatchObject({
      projectId: "confuse-kimi-code",
    });
    expect(history.cursors.has(`confuse-kimi-code:${source.id}`)).toBe(true);

    const [duplicate] = await project.import(["kimi-code"]);
    expect(duplicate.scanned).toBe(0);
    expect(outbox.entries.size).toBe(2);
  });

  it("resumes DSH by format and sequence without compressed offsets", async () => {
    const history = new MemoryHistoryStore();
    const outbox = new MemoryOutboxStore();
    const reader = new FakeDshReader([event("1", "v1"), event("2", "v1")]);
    const source: DshHistorySource = {
      kind: "dsh",
      id: "dsh-source",
      agent: "deepseek-harness",
      sessionId: "session",
      formatVersion: "v1",
      reader,
    };
    const service = new HistoryService({
      sources: [source],
      store: history,
      outbox,
    });
    const [first] = await service.import(["deepseek-harness"]);
    expect(first.enqueued).toBe(2);

    await service.import(["deepseek-harness"]);
    expect(reader.afterSeq).toEqual([undefined, "2"]);

    const migratedReader = new FakeDshReader([event("1", "v2")]);
    const migrated = new HistoryService({
      sources: [{ ...source, formatVersion: "v2", reader: migratedReader }],
      store: history,
      outbox,
    });
    const [migration] = await migrated.import(["deepseek-harness"]);
    expect(migration.enqueued).toBe(1);
    expect(migratedReader.afterSeq).toEqual([undefined]);
    expect(outbox.entries.size).toBe(3);
  });
});

class MemoryHistoryStore implements HistoryStore {
  readonly cursors = new Map<string, HistoryCursor>();

  async getCursor(sourceId: string): Promise<HistoryCursor | undefined> {
    return this.cursors.get(sourceId);
  }

  async saveCursor(sourceId: string, cursor: HistoryCursor): Promise<void> {
    this.cursors.set(sourceId, cursor);
  }
}

class MemoryOutboxStore {
  readonly entries = new Map<string, OutboxEntry>();
  onPut?: () => void;

  async putIfAbsent(entry: OutboxEntry): Promise<boolean> {
    if (this.entries.has(entry.id)) return false;
    this.entries.set(entry.id, entry);
    this.onPut?.();
    return true;
  }
}

class FakeDshReader {
  readonly afterSeq: Array<string | undefined> = [];

  constructor(private readonly events: DshSessionEvent[]) {}

  async *readEvents(request: {
    afterSeq?: string;
  }): AsyncIterable<DshSessionEvent> {
    this.afterSeq.push(request.afterSeq);
    for (const item of this.events) {
      if (
        request.afterSeq === undefined ||
        BigInt(item.seq) > BigInt(request.afterSeq)
      )
        yield item;
    }
  }
}

function event(seq: string, formatVersion: string): DshSessionEvent {
  return {
    sessionId: "session",
    formatVersion,
    seq,
    type: "message",
    payload: { synthetic: true },
  };
}

async function jsonlFixture() {
  const root = await mkdtemp(join(tmpdir(), "confuse-history-service-"));
  directories.push(root);
  const file = join(root, "wire.jsonl");
  return {
    root,
    file,
    source: {
      kind: "jsonl",
      id: "kimi-source",
      agent: "kimi-code",
      root,
      relativePath: "wire.jsonl",
      workspaceId: "workspace",
    } satisfies JsonlHistorySource,
  };
}
