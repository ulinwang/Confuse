import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentContext, HookTransport } from "./types";

function defaultHookTransport(homeDir: string): HookTransport {
  return {
    type: "unix-socket",
    socketPath: join(
      homeDir,
      "Library",
      "Application Support",
      "Confuse",
      "supervisor.sock",
    ),
  };
}

export function createAgentContext(
  overrides: Partial<AgentContext> = {},
): AgentContext {
  const homeDir =
    overrides.homeDir ?? overrides.env?.HOME ?? process.env.HOME ?? homedir();
  return {
    homeDir,
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    applicationDirs: overrides.applicationDirs ?? [
      "/Applications",
      join(homeDir, "Applications"),
    ],
    nodePath: overrides.nodePath ?? process.execPath,
    transport: overrides.transport ?? defaultHookTransport(homeDir),
    now: overrides.now ?? (() => new Date()),
    ...(overrides.isCodexHookTrusted === undefined
      ? {}
      : { isCodexHookTrusted: overrides.isCodexHookTrusted }),
  };
}

export function assertSafeTransport(transport: HookTransport): void {
  if (transport.type === "unix-socket") {
    if (
      !transport.socketPath.startsWith("/") ||
      transport.socketPath.includes("\0")
    ) {
      throw new Error(
        "Confuse agent forwarding requires an absolute Unix socket path",
      );
    }
    return;
  }
  const url = new URL(transport.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Confuse agent forwarding only accepts a credential-free loopback HTTP URL",
    );
  }
}
