import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentBackup,
  AgentConfigPreview,
  AgentFilePreview,
  PlannedWrite,
} from "./types";
import type { AgentKind } from "../../shared/contracts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      throw new Error(`Expected a regular file: ${path}`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function filePreview(write: PlannedWrite): AgentFilePreview {
  return {
    path: write.path,
    action:
      write.before === null
        ? "create"
        : write.after === null
          ? "delete"
          : "update",
    ...(write.before === null ? {} : { beforeSha256: sha256(write.before) }),
    ...(write.after === null ? {} : { afterSha256: sha256(write.after) }),
    patch: write.preview,
  };
}

export function createPreview(
  kind: AgentKind,
  writes: PlannedWrite[],
  message?: string,
): AgentConfigPreview {
  const changedWrites = writes.filter((write) => write.before !== write.after);
  return {
    kind,
    supported: true,
    changed: changedWrites.length > 0,
    files: changedWrites.map(filePreview),
    ...(message === undefined ? {} : { message }),
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.confuse-tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function commitWrites(
  writes: PlannedWrite[],
  now: Date,
): Promise<AgentBackup[]> {
  const changed = writes.filter((write) => write.before !== write.after);
  const backups: AgentBackup[] = [];
  const applied: PlannedWrite[] = [];
  const stamp = now.toISOString().replaceAll(/[^0-9]/g, "");

  try {
    for (const write of changed) {
      const current = await readTextIfExists(write.path);
      if (current !== write.before) {
        throw new Error(`Configuration changed after preview: ${write.path}`);
      }
    }

    for (const write of changed) {
      let backupPath: string | undefined;
      if (write.before !== null) {
        backupPath = `${write.path}.confuse-backup-${stamp}-${randomUUID()}`;
        await copyFile(write.path, backupPath);
        await chmod(backupPath, 0o600);
      }
      backups.push({
        originalPath: write.path,
        ...(backupPath === undefined ? {} : { backupPath }),
      });
    }

    for (const write of changed) {
      if (write.after === null) {
        await unlink(write.path);
      } else {
        await atomicWrite(write.path, write.after);
      }
      applied.push(write);
    }
    return backups;
  } catch (error) {
    for (const write of applied.reverse()) {
      if (write.before === null) {
        await rm(write.path, { force: true }).catch(() => undefined);
      } else {
        await atomicWrite(write.path, write.before).catch(() => undefined);
      }
    }
    throw error;
  }
}

export function replaceManagedBlock(
  source: string,
  startMarker: string,
  endMarker: string,
  block: string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
    return `${source}${separator}${block}\n`;
  }
  const end = source.indexOf(endMarker, start);
  if (end < 0)
    throw new Error("Incomplete Confuse managed configuration block");
  const afterEnd = end + endMarker.length;
  const remainder = source.slice(afterEnd).replace(/^\r?\n/, "");
  return `${source.slice(0, start)}${block}${remainder.length > 0 ? `\n${remainder}` : "\n"}`;
}

export function removeManagedBlock(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start);
  if (end < 0)
    throw new Error("Incomplete Confuse managed configuration block");
  const afterEnd = end + endMarker.length;
  return `${source.slice(0, start)}${source.slice(afterEnd).replace(/^\r?\n/, "")}`;
}
