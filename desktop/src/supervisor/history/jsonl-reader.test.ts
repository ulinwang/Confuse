import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonlIncrementally } from "./jsonl-reader.js";
import type { JsonlCursor, JsonlHistorySource } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("incremental JSONL reader", () => {
  it("commits complete lines and resumes a split UTF-8 line", async () => {
    const { source, file } = await fixture();
    const first = `${JSON.stringify({ id: 1 })}\n`;
    const second = `${JSON.stringify({ id: 2, text: `${"a".repeat(70_000)}🐯` })}\n`;
    const bytes = Buffer.from(second);
    const emoji = bytes.indexOf(Buffer.from("🐯"));
    await writeFile(
      file,
      Buffer.concat([Buffer.from(first), bytes.subarray(0, emoji + 1)]),
    );

    const initial = await collect(source);
    expect(initial.lines).toEqual([JSON.stringify({ id: 1 })]);
    expect(initial.cursor.offset).toBe(Buffer.byteLength(first));

    await writeFile(file, bytes.subarray(emoji + 1), { flag: "a" });
    const resumed = await collect(source, initial.cursor);
    expect(resumed.lines).toEqual([second.trimEnd()]);
    expect(resumed.cursor.offset).toBe(Buffer.byteLength(first) + bytes.length);
  });

  it("resets on truncate, same-inode rewrite, and inode replacement", async () => {
    const { source, file, root } = await fixture();
    await writeFile(file, '{"id":"old-1"}\n{"id":"old-2"}\n');
    const first = await collect(source);

    await writeFile(file, '{"id":"truncated"}\n');
    const truncated = await collect(source, first.cursor);
    expect(truncated.reset).toBe(true);
    expect(truncated.lines).toEqual(['{"id":"truncated"}']);

    await writeFile(file, '{"id":"new-1"}\n{"id":"new-2"}\n{"id":"new-3"}\n');
    const rewritten = await collect(source, truncated.cursor);
    expect(rewritten.reset).toBe(true);
    expect(rewritten.lines).toHaveLength(3);
    expect(rewritten.lines[0]).toContain("new-1");

    await rename(file, join(root, "old.jsonl"));
    await writeFile(file, '{"id":"replacement"}\n');
    const replaced = await collect(source, rewritten.cursor);
    expect(replaced.reset).toBe(true);
    expect(replaced.lines).toEqual(['{"id":"replacement"}']);
  });

  it("verifies a rewrite boundary after an empty complete line", async () => {
    const { source, file } = await fixture();
    await writeFile(file, "\n");
    const first = await collect(source);
    expect(first.cursor.lastCompleteLine).toBe("");

    await writeFile(file, '{"id":"new"}\n');
    const rewritten = await collect(source, first.cursor);
    expect(rewritten.reset).toBe(true);
    expect(rewritten.lines).toEqual(['{"id":"new"}']);
  });

  it("replays zstd from the start and detects a rewritten logical boundary", async () => {
    const { source, file } = await fixture("events.jsonl.zst");
    const compress = promisify(zstdCompress);
    await writeFile(file, await compress('{"id":"old-1"}\n{"id":"old-2"}\n'));
    const first = await collect(source);
    expect(first.lines).toHaveLength(2);
    expect(first.cursor.offset).toBeGreaterThan(0);

    await writeFile(file, await compress('{"id":"new-1"}\n{"id":"new-2"}\n'));
    const second = await collect(source, first.cursor);
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(['{"id":"new-1"}', '{"id":"new-2"}']);
    expect(second.cursor.size).toBe((await stat(file)).size);
  });

  it("rejects files and symlinks outside the authorized root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "confuse-jsonl-auth-"));
    directories.push(parent);
    const root = join(parent, "authorized");
    await mkdir(root);
    const outside = join(parent, "outside.jsonl");
    await writeFile(outside, '{"id":1}\n');
    const source: JsonlHistorySource = {
      kind: "jsonl",
      id: "fixture",
      agent: "kimi-code",
      root,
      relativePath: "../outside.jsonl",
    };
    await expect(collect(source)).rejects.toThrow("authorized root");
    await symlink(outside, join(root, "linked.jsonl"));
    await expect(
      collect({ ...source, relativePath: "linked.jsonl" }),
    ).rejects.toThrow("authorized root");
  });
});

async function collect(source: JsonlHistorySource, cursor?: JsonlCursor) {
  const lines: string[] = [];
  const result = await readJsonlIncrementally({
    source,
    cursor,
    onLine: async ({ text }) => {
      lines.push(text);
    },
  });
  return { ...result, lines };
}

async function fixture(name = "events.jsonl") {
  const root = await mkdtemp(join(tmpdir(), "confuse-jsonl-"));
  directories.push(root);
  return {
    root,
    file: join(root, name),
    source: {
      kind: "jsonl",
      id: "fixture",
      agent: "kimi-code",
      root,
      relativePath: name,
      sessionId: "session",
    } satisfies JsonlHistorySource,
  };
}
