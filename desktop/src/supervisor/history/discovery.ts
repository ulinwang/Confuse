import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ConnectAgentSelection } from "../../shared/contracts";
import type { JsonlAgentKind, JsonlHistorySource } from "./types";

const HISTORY_DIRECTORIES: Record<JsonlAgentKind, readonly string[]> = {
  "kimi-code": ["sessions", "projects", "history"],
  "chatgpt-codex": ["sessions", "archived_sessions"],
  "claude-code": ["projects"],
};

const MAXIMUM_HISTORY_FILES = 10_000;

export async function discoverJsonlHistorySources(
  selection: ConnectAgentSelection & { kind: JsonlAgentKind },
  root: string,
): Promise<JsonlHistorySource[]> {
  if (!isAbsolute(root)) {
    throw new Error("Authorized Agent history root must be an absolute path");
  }
  const authorizedRoot = await existingRealDirectory(root);
  if (!authorizedRoot) return [];

  const directories: string[] = [];
  for (const directory of HISTORY_DIRECTORIES[selection.kind]) {
    const path = await containedRealDirectory(authorizedRoot, directory);
    if (path) directories.push(path);
  }

  const files: Array<{ path: string; relativePath: string }> = [];
  for (const directory of directories) {
    await walk(authorizedRoot, directory, files);
  }
  if (selection.kind === "chatgpt-codex") {
    const legacy = await containedRealFile(authorizedRoot, "history.jsonl");
    if (legacy) {
      files.push({ path: legacy, relativePath: "history.jsonl" });
    }
  }

  const unique = new Map<string, { path: string; relativePath: string }>();
  for (const file of files) unique.set(file.relativePath, file);
  if (unique.size > MAXIMUM_HISTORY_FILES) {
    throw new Error("Authorized Agent history contains too many files");
  }

  return [...unique.values()]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(({ relativePath }) => {
      const id = createHash("sha256")
        .update(`${selection.kind}\0${authorizedRoot}\0${relativePath}`)
        .digest("hex");
      const fileName = basename(relativePath);
      const withoutExtension = fileName.replace(/\.jsonl(?:\.zst)?$/, "");
      const parentName = basename(dirname(relativePath));
      return {
        kind: "jsonl",
        id,
        agent: selection.kind,
        root: authorizedRoot,
        relativePath,
        ...(relativePath.endsWith(".zst")
          ? { compression: "zstd" as const }
          : {}),
        ...(selection.kind === "kimi-code"
          ? {
              sessionId:
                fileName === "wire.jsonl" || fileName === "wire.jsonl.zst"
                  ? parentName
                  : withoutExtension,
              workspaceId: dirname(relativePath),
            }
          : {}),
        ...(selection.kind === "chatgpt-codex"
          ? { rolloutId: withoutExtension }
          : {}),
        ...(selection.kind === "claude-code"
          ? { transcriptId: withoutExtension }
          : {}),
      };
    });
}

async function walk(
  authorizedRoot: string,
  directory: string,
  files: Array<{ path: string; relativePath: string }>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(authorizedRoot, path, files);
      continue;
    }
    if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/.test(entry.name)) continue;
    const relativePath = relative(authorizedRoot, path);
    assertContained(authorizedRoot, resolve(authorizedRoot, relativePath));
    files.push({ path, relativePath });
    if (files.length > MAXIMUM_HISTORY_FILES) {
      throw new Error("Authorized Agent history contains too many files");
    }
  }
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

async function containedRealDirectory(
  root: string,
  path: string,
): Promise<string | undefined> {
  const candidate = resolve(root, path);
  assertContained(root, candidate);
  const resolved = await existingRealDirectory(candidate);
  if (resolved) assertContained(root, resolved);
  return resolved;
}

async function containedRealFile(
  root: string,
  path: string,
): Promise<string | undefined> {
  const candidate = resolve(root, path);
  assertContained(root, candidate);
  try {
    const resolved = await realpath(candidate);
    assertContained(root, resolved);
    return (await stat(resolved)).isFile() ? resolved : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Agent history source escapes its authorized root");
  }
}
