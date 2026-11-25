import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import {
  apply as applyJsonlPersistence,
  type JsonlCompression,
} from "@deepseek-ai/dsh-session-persistence-jsonl";
import type {
  DshHistorySource,
  DshSessionEvent,
  DshSessionQuery,
} from "./types.js";

export interface DshHistoryConnection {
  sources: DshHistorySource[];
  close(): Promise<void>;
}

export async function openDshHistory(
  root: string,
  options: { compression?: JsonlCompression; signal?: AbortSignal } = {},
): Promise<DshHistoryConnection> {
  if (!isAbsolute(root)) {
    throw new Error("Authorized DSH history root must be an absolute path");
  }
  const authorizedRoot = await existingRealDirectory(root);
  if (!authorizedRoot) return { sources: [], close: async () => undefined };

  if (options.compression) {
    return openWithCompression(
      authorizedRoot,
      options.compression,
      options.signal,
    );
  }
  try {
    return await openWithCompression(authorizedRoot, "zstd", options.signal);
  } catch (error) {
    if (!isCompressionMismatch(error)) throw error;
    return openWithCompression(authorizedRoot, "none", options.signal);
  }
}

async function openWithCompression(
  root: string,
  compression: JsonlCompression,
  signal: AbortSignal | undefined,
): Promise<DshHistoryConnection> {
  const context = new Context();
  try {
    await context.plugin(applyJsonlPersistence, { root, compression });
    const snapshots = await context.sessionPersistence.list({ signal });
    const sources = snapshots.map((snapshot) =>
      createSource(root, context.sessionPersistence, snapshot.header),
    );
    return {
      sources,
      close: () => context.fiber.dispose(),
    };
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}

function isCompressionMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("but this backend is configured for compression")
  );
}

function createSource(
  root: string,
  persistence: SessionPersistence,
  header: SessionHeader,
): DshHistorySource {
  const sessionId = String(header.id);
  const formatVersion = String(header.version);
  return {
    kind: "dsh",
    id: createHash("sha256")
      .update(`deepseek-harness\0${root}\0${sessionId}`)
      .digest("hex"),
    agent: "deepseek-harness",
    sessionId,
    formatVersion,
    reader: new OfficialDshSessionQuery(persistence, header.id, formatVersion),
  };
}

class OfficialDshSessionQuery implements DshSessionQuery {
  constructor(
    private readonly persistence: SessionPersistence,
    private readonly id: SessionId,
    private readonly sourceFormatVersion: string,
  ) {}

  async *readEvents(request: {
    sessionId: string;
    formatVersion: string;
    afterSeq?: string;
    signal?: AbortSignal;
  }): AsyncIterable<DshSessionEvent> {
    if (
      request.sessionId !== String(this.id) ||
      request.formatVersion !== this.sourceFormatVersion
    ) {
      return;
    }
    const offset = nextOffset(request.afterSeq);
    const handle = await this.persistence.open(this.id, "read", {
      signal: request.signal,
    });
    try {
      const result = await handle.read(offset, Number.MAX_SAFE_INTEGER, {
        signal: request.signal,
      });
      for (const event of result.events) {
        request.signal?.throwIfAborted();
        yield toHistoryEvent(
          request.sessionId,
          this.sourceFormatVersion,
          event,
        );
      }
    } finally {
      await handle.close();
    }
  }
}

function nextOffset(afterSeq: string | undefined): number {
  if (afterSeq === undefined) return 0;
  const next = BigInt(afterSeq) + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DSH history cursor exceeds the Session sequence range");
  }
  return Number(next);
}

function toHistoryEvent(
  sessionId: string,
  formatVersion: string,
  event: SessionEvent,
): DshSessionEvent {
  return {
    sessionId,
    formatVersion,
    seq: String(event.seq),
    type: event.type,
    timestamp: new Date(event.time).toISOString(),
    payload: event.data,
  };
}

async function existingRealDirectory(
  path: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
