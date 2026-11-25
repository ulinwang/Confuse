import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { decode } from "he";
import type { AgentContext } from "./types";

const execFileAsync = promisify(execFile);

export async function findExecutable(
  name: string,
  context: AgentContext,
): Promise<string | undefined> {
  for (const directory of (context.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

function extractVersion(value: string): string | undefined {
  return value.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
}

export async function readCliVersion(
  executable: string | undefined,
  args: string[],
  context: AgentContext,
): Promise<string | undefined> {
  if (!executable) return undefined;
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      env: { HOME: context.homeDir, PATH: context.env.PATH ?? "", LANG: "C" },
      timeout: 1_500,
      maxBuffer: 32 * 1024,
      windowsHide: true,
    });
    return extractVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

export async function readBundleMetadata(appPath: string): Promise<{
  bundleId?: string;
  version?: string;
}> {
  try {
    const plist = await readFile(
      join(appPath, "Contents", "Info.plist"),
      "utf8",
    );
    const readKey = (key: string): string | undefined => {
      for (const match of plist.matchAll(
        /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g,
      )) {
        if (decode(match[1]) === key) return decode(match[2]);
      }
      return undefined;
    };
    return {
      bundleId: readKey("CFBundleIdentifier"),
      version: readKey("CFBundleShortVersionString"),
    };
  } catch {
    return {};
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
