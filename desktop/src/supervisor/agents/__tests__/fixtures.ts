import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentKind,
  ConnectAgentSelection,
} from "../../../shared/contracts";
import { createAgentContext } from "../context";
import type { AgentContext, HookTransport } from "../types";

export interface AgentFixture {
  root: string;
  home: string;
  apps: string;
  bin: string;
  context: AgentContext;
}

export async function createAgentFixture(
  transport?: HookTransport,
): Promise<AgentFixture> {
  const root = await mkdtemp(join(tmpdir(), "confuse-agent-fixture-"));
  const home = join(root, "home");
  const apps = join(root, "Applications");
  const bin = join(root, "bin");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(apps, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  const context = createAgentContext({
    homeDir: home,
    env: { HOME: home, PATH: bin },
    applicationDirs: [apps],
    nodePath: process.execPath,
    transport: transport ?? {
      type: "unix-socket",
      socketPath: join(root, "confuse.sock"),
    },
    now: () => new Date("2026-11-25T08:00:00.000Z"),
  });
  return { root, home, apps, bin, context };
}

export async function installFakeCli(
  fixture: AgentFixture,
  name: string,
  version: string,
): Promise<void> {
  const path = join(fixture.bin, name);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${name} ${version}'; fi\n`,
  );
  await chmod(path, 0o755);
}

export async function installFakeApp(
  fixture: AgentFixture,
  name: string,
  bundleId: string,
  version: string,
  directory = fixture.apps,
): Promise<string> {
  const appPath = join(directory, name);
  const contents = join(appPath, "Contents");
  await mkdir(contents, { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>${bundleId}</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n</dict></plist>\n`,
  );
  return appPath;
}

export function selection(
  kind: AgentKind,
  configPath?: string,
  importHistory = false,
): ConnectAgentSelection {
  return {
    kind,
    importHistory,
    ...(configPath === undefined ? {} : { configPath }),
  };
}
