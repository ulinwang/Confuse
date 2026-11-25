import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
import type {
  HistoryCompression,
  JsonlCursor,
  JsonlHistorySource,
} from "./types.js";

interface JsonlLine {
  text: string;
  cursor: JsonlCursor;
}

export interface JsonlReadResult {
  cursor: JsonlCursor;
  completeLines: number;
  reset: boolean;
}

export interface ReadJsonlOptions {
  source: JsonlHistorySource;
  cursor?: JsonlCursor;
  signal?: AbortSignal;
  onLine: (line: JsonlLine) => Promise<void>;
}

interface ResolvedSource {
  path: string;
  compression: HistoryCompression;
}

class CursorBoundaryMismatch extends Error {}

async function resolveAuthorizedSource(
  source: JsonlHistorySource,
): Promise<ResolvedSource> {
  if (!isAbsolute(source.root) || isAbsolute(source.relativePath)) {
    throw new Error(
      "History source must use an absolute root and relative file path",
    );
  }

  const root = await realpath(source.root);
  const candidate = resolve(root, source.relativePath);
  assertContained(root, candidate);
  const path = await realpath(candidate);
  assertContained(root, path);
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error("History source is not a regular file");
  }

  return {
    path,
    compression:
      source.compression ?? (path.endsWith(".zst") ? "zstd" : "none"),
  };
}

export async function readJsonlIncrementally(
  options: ReadJsonlOptions,
): Promise<JsonlReadResult> {
  const { path, compression } = await resolveAuthorizedSource(options.source);
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}`;
    let cursor = options.cursor;
    let reset = false;

    if (
      cursor &&
      (cursor.kind !== "jsonl" ||
        cursor.identity !== identity ||
        cursor.compression !== compression ||
        cursor.size > info.size ||
        cursor.offset > uncompressedLimit(cursor, info.size))
    ) {
      cursor = undefined;
      reset = true;
    }

    if (compression === "none" && cursor?.lastCompleteLine !== undefined) {
      const valid = await verifyPlainBoundary(handle, cursor);
      if (!valid) {
        cursor = undefined;
        reset = true;
      }
    }

    const base: JsonlCursor = cursor ?? {
      kind: "jsonl",
      identity,
      compression,
      offset: 0,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };

    if (
      compression === "none" &&
      base.offset === info.size &&
      base.lastCompleteLine !== undefined
    ) {
      return {
        cursor: { ...base, size: info.size, mtimeMs: info.mtimeMs },
        completeLines: 0,
        reset,
      };
    }

    let completeLines = 0;
    const processStream = async (start: number, skipBefore: number) => {
      const input = handle.createReadStream({
        start,
        autoClose: false,
        highWaterMark: 64 * 1024,
      });
      const readable: Readable =
        compression === "zstd" ? input.pipe(createZstdDecompress()) : input;
      let pending = Buffer.alloc(0);
      let offset = compression === "none" ? start : 0;
      let boundaryVerified = skipBefore === 0;
      let current = {
        ...base,
        offset: compression === "none" ? start : skipBefore,
      };

      for await (const chunk of readable) {
        throwIfAborted(options.signal);
        pending =
          pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let newline = pending.indexOf(0x0a);
        while (newline !== -1) {
          const raw = pending.subarray(0, newline);
          const lineEnd = offset + newline + 1;
          const text = raw.toString("utf8");
          pending = pending.subarray(newline + 1);
          offset = lineEnd;

          if (lineEnd <= skipBefore) {
            if (compression === "zstd" && lineEnd === skipBefore) {
              if (
                base.lastCompleteLine === undefined ||
                text !== base.lastCompleteLine
              ) {
                throw new CursorBoundaryMismatch();
              }
              boundaryVerified = true;
            }
            newline = pending.indexOf(0x0a);
            continue;
          }

          current = {
            ...current,
            offset: lineEnd,
            size: info.size,
            mtimeMs: info.mtimeMs,
            lastCompleteLine: text,
          };
          completeLines += 1;
          await options.onLine({
            text: stripCarriageReturn(text),
            cursor: { ...current },
          });
          throwIfAborted(options.signal);
          newline = pending.indexOf(0x0a);
        }
      }

      if (compression === "zstd" && !boundaryVerified) {
        throw new CursorBoundaryMismatch();
      }
      return current;
    };

    try {
      const start = compression === "none" ? base.offset : 0;
      const skipBefore = compression === "none" ? 0 : base.offset;
      const finalCursor = await processStream(start, skipBefore);
      return { cursor: finalCursor, completeLines, reset };
    } catch (error) {
      if (error instanceof CursorBoundaryMismatch) {
        const replayBase: JsonlCursor = {
          kind: "jsonl",
          identity,
          compression,
          offset: 0,
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
        const replay = await processStreamWithFreshHandle(
          handle,
          replayBase,
          options,
          () => {
            completeLines += 1;
          },
        );
        return { cursor: replay, completeLines, reset: true };
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function processStreamWithFreshHandle(
  handle: import("node:fs/promises").FileHandle,
  base: JsonlCursor,
  options: ReadJsonlOptions,
  countLine: () => void,
): Promise<JsonlCursor> {
  const input = handle.createReadStream({ start: 0, autoClose: false });
  const readable = input.pipe(createZstdDecompress());
  let pending = Buffer.alloc(0);
  let offset = 0;
  let current = base;

  for await (const chunk of readable) {
    throwIfAborted(options.signal);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      const text = pending.subarray(0, newline).toString("utf8");
      offset += newline + 1;
      pending = pending.subarray(newline + 1);
      current = { ...current, offset, lastCompleteLine: text };
      countLine();
      await options.onLine({
        text: stripCarriageReturn(text),
        cursor: { ...current },
      });
      throwIfAborted(options.signal);
      newline = pending.indexOf(0x0a);
    }
  }

  return current;
}

async function verifyPlainBoundary(
  handle: import("node:fs/promises").FileHandle,
  cursor: JsonlCursor,
): Promise<boolean> {
  const lastLine = cursor.lastCompleteLine;
  if (lastLine === undefined) return cursor.offset === 0;
  const lineBytes = Buffer.byteLength(lastLine);
  const start = cursor.offset - lineBytes - 1;
  if (start < 0) return false;
  const expected = Buffer.from(`${lastLine}\n`);
  const actual = Buffer.alloc(expected.length);
  const { bytesRead } = await handle.read(actual, 0, actual.length, start);
  return bytesRead === expected.length && actual.equals(expected);
}

function uncompressedLimit(cursor: JsonlCursor, sourceSize: number): number {
  return cursor.compression === "none" ? sourceSize : Number.MAX_SAFE_INTEGER;
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw new Error("History source escapes its authorized root");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("History import cancelled", "AbortError");
  }
}
