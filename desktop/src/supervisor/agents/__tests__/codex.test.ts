import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatGptCodexAdapter } from "../chatgpt-codex";
import { createCodexTrustChecker } from "../codex-trust";
import { connectAgents, detectAgentConnectionState, scanAgents } from "..";
import {
  createAgentFixture,
  installFakeApp,
  selection,
  type AgentFixture,
} from "./fixtures";

let fixture: AgentFixture;
let appServers: Server[];
let codexHomes: string[];

const APP_SERVER_EVENTS = [
  "sessionStart",
  "userPromptSubmit",
  "preToolUse",
  "postToolUse",
  "postModelRequest",
  "stop",
  "sessionEnd",
];

function serverTextFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function clientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (!masked || buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

async function startFakeAppServer(
  codexHome: string,
  hooks: Record<string, unknown>[],
): Promise<{ requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const socketPath = join(
    codexHome,
    "app-server-control",
    "app-server-control.sock",
  );
  await mkdir(join(codexHome, "app-server-control"), { recursive: true });
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    function sendResponse(id: unknown, result: unknown): void {
      socket.write(serverTextFrame({ jsonrpc: "2.0", id, result }));
    }

    function handleData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const key = /\r\nSec-WebSocket-Key: ([^\r\n]+)/i.exec(header)?.[1];
        if (!key) {
          socket.destroy();
          return;
        }
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
      }
      while (upgraded) {
        const frame = clientFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        if (frame.opcode === 8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString("utf8")) as Record<
          string,
          unknown
        >;
        requests.push(message);
        if (message.method === "initialize") {
          sendResponse(message.id, { userAgent: "fake-codex" });
        } else if (message.method === "hooks/list") {
          const previous = requests.at(-2);
          const params = message.params as Record<string, unknown>;
          if (
            previous?.method !== "initialized" ||
            !Array.isArray(params.cwds) ||
            params.cwds.length !== 0
          ) {
            socket.destroy();
            return;
          }
          sendResponse(message.id, {
            data: [{ cwd: fixture.home, hooks, warnings: [], errors: [] }],
          });
        }
      }
    }

    socket.on("data", handleData);
    socket.on("error", () => {});
  });
  appServers.push(server);
  server.listen(socketPath);
  await once(server, "listening");
  return { requests };
}

function hookMetadata(
  command: string,
  sourcePath: string,
  trustStatus: string,
  enabled = true,
): Record<string, unknown>[] {
  return APP_SERVER_EVENTS.map((eventName) => ({
    eventName,
    handlerType: "command",
    command,
    sourcePath,
    enabled,
    trustStatus,
  }));
}

async function createCodexHome(): Promise<string> {
  const codexHome = await mkdtemp("/tmp/confuse-codex-");
  codexHomes.push(codexHome);
  return codexHome;
}

beforeEach(async () => {
  fixture = await createAgentFixture();
  appServers = [];
  codexHomes = [];
});

afterEach(async () => {
  await Promise.all(
    appServers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    ...codexHomes.map((home) => rm(home, { recursive: true, force: true })),
  ]);
});

describe("ChatGPT desktop Codex", () => {
  it("discovers the desktop bundle without a CLI and waits for exact-hook review", async () => {
    const classicApps = join(fixture.root, "classic-apps");
    await mkdir(classicApps, { recursive: true });
    await installFakeApp(
      fixture,
      "ChatGPT.app",
      "com.openai.chat",
      "1.0.0",
      classicApps,
    );
    fixture.context.applicationDirs.unshift(classicApps);
    const appPath = await installFakeApp(
      fixture,
      "ChatGPT.app",
      "com.openai.codex",
      "26.1023.50603",
    );
    const home = join(fixture.home, "codex-custom");
    await mkdir(home, { recursive: true });
    fixture.context.env.CODEX_HOME = home;
    const configPath = join(home, "hooks.json");
    await writeFile(
      configPath,
      JSON.stringify({
        description: "mine",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] },
      }),
    );
    const selected = selection("chatgpt-codex");

    const infos = await scanAgents(fixture.context);
    expect(infos.find((info) => info.kind === "chatgpt-codex")).toMatchObject({
      installed: true,
      applicationPath: appPath,
      version: "26.1023.50603",
    });

    const [connected] = await connectAgents([selected], fixture.context);
    expect(connected.state).toBe("waiting-for-review");
    expect(connected.message).toContain("Review hooks");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.description).toBe("mine");
    expect(config.hooks.Stop[0].hooks[0].command).toBe("mine");
    expect(config.hooks.SessionEnd.at(-1).hooks[0].async).toBeUndefined();
    expect(config.hooks.Stop.at(-1).hooks[0].async).toBe(true);
    expect(await detectAgentConnectionState(selected, fixture.context)).toBe(
      "waiting-for-review",
    );

    fixture.context.isCodexHookTrusted = async (command, sourcePath) => {
      expect(command).toContain("confuse-forward.mjs");
      expect(sourcePath).toBe(configPath);
      return true;
    };
    expect(
      await chatGptCodexAdapter.detectStatus(selected, fixture.context),
    ).toBe("connected");
    const [trustedConnection] = await connectAgents(
      [selected],
      fixture.context,
    );
    expect(trustedConnection.state).toBe("connected");
    expect(trustedConnection.changed).toBe(false);
  });

  it("does not mistake ChatGPT Classic for desktop Codex", async () => {
    await installFakeApp(fixture, "ChatGPT.app", "com.openai.chat", "1.0.0");
    const info = await chatGptCodexAdapter.discover(fixture.context);
    expect(info.installed).toBe(false);
    expect(info.liveCaptureSupported).toBe(false);
    expect(info.applicationPath).toBeUndefined();
  });

  it.each([
    { trustStatus: "untrusted", enabled: true, expected: false },
    { trustStatus: "modified", enabled: true, expected: false },
    { trustStatus: "trusted", enabled: true, expected: true },
    { trustStatus: "trusted", enabled: false, expected: false },
  ])(
    "checks official hook trust for $trustStatus enabled=$enabled",
    async ({ trustStatus, enabled, expected }) => {
      const codexHome = await createCodexHome();
      const command = "node /tmp/confuse-forward.mjs chatgpt-codex";
      const sourcePath = join(codexHome, "hooks.json");
      const { requests } = await startFakeAppServer(
        codexHome,
        hookMetadata(command, sourcePath, trustStatus, enabled),
      );
      const isTrusted = createCodexTrustChecker({
        env: { CODEX_HOME: codexHome },
        homeDir: fixture.home,
        timeoutMs: 500,
      });

      await expect(isTrusted(command, sourcePath)).resolves.toBe(expected);
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "hooks/list",
      ]);
    },
  );

  it("rejects a trusted hook from another source or with a missing event", async () => {
    const codexHome = await createCodexHome();
    const command = "node /tmp/confuse-forward.mjs chatgpt-codex";
    const sourcePath = join(codexHome, "hooks.json");
    const hooks = hookMetadata(command, sourcePath, "trusted").filter(
      (hook) => hook.eventName !== "sessionEnd",
    );
    await startFakeAppServer(codexHome, hooks);
    const isTrusted = createCodexTrustChecker({
      env: { CODEX_HOME: codexHome },
      homeDir: fixture.home,
      timeoutMs: 500,
    });

    await expect(isTrusted(command, sourcePath)).resolves.toBe(false);
    await expect(
      isTrusted(command, join(codexHome, "other.json")),
    ).resolves.toBe(false);
  });

  it("returns false when the app-server API is unavailable", async () => {
    const codexHome = join(fixture.root, "codex-unavailable");
    const isTrusted = createCodexTrustChecker({
      env: { CODEX_HOME: codexHome },
      homeDir: fixture.home,
      timeoutMs: 50,
    });

    await expect(
      isTrusted("node /tmp/confuse-forward.mjs chatgpt-codex", "hooks.json"),
    ).resolves.toBe(false);
  });
});
