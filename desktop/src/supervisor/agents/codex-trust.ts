import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostModelRequest",
  "Stop",
  "SessionEnd",
] as const;

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface CodexTrustCheckerOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  timeoutMs?: number;
}

export type CodexTrustChecker = (
  command: string,
  sourcePath: string,
) => Promise<boolean>;

interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer: Buffer): WebSocketFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
    throw new Error("Invalid Codex app-server WebSocket frame");
  }
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const extendedLength = buffer.readBigUInt64BE(2);
    if (extendedLength > BigInt(MAX_MESSAGE_BYTES)) {
      throw new Error("Codex app-server WebSocket message is too large");
    }
    length = Number(extendedLength);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error("Codex app-server WebSocket message is too large");
  }
  if (buffer.length < offset + length) return null;
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload: buffer.subarray(offset, offset + length),
    rest: buffer.subarray(offset + length),
  };
}

function queryCodexHooks(
  socketPath: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    let socket: Socket | undefined;
    let settled = false;
    let stage: "initialize" | "hooks" = "initialize";
    let buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let fragmentOpcode: number | undefined;
    const timer = setTimeout(() => {
      fail(new Error("Codex app-server request timed out"));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      rpcRequest.destroy();
      socket?.destroy();
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function succeed(result: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function send(value: unknown): void {
      socket?.write(encodeFrame(1, Buffer.from(JSON.stringify(value))));
    }

    function handleMessage(payload: Buffer): void {
      const message: unknown = JSON.parse(payload.toString("utf8"));
      if (!isRecord(message)) return;
      if (stage === "initialize" && message.id === 1) {
        if (message.error !== undefined || message.result === undefined) {
          fail(new Error("Codex app-server initialization failed"));
          return;
        }
        stage = "hooks";
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "hooks/list",
          params: { cwds: [] },
        });
      } else if (stage === "hooks" && message.id === 2) {
        if (message.error !== undefined || message.result === undefined) {
          fail(new Error("Codex app-server hooks/list failed"));
          return;
        }
        succeed(message.result);
      }
    }

    function handleFrame(frame: WebSocketFrame): void {
      if (frame.opcode >= 8) {
        if (!frame.fin || frame.payload.length > 125) {
          throw new Error("Invalid Codex app-server control frame");
        }
        if (frame.opcode === 8) {
          fail(new Error("Codex app-server closed the connection"));
        } else if (frame.opcode === 9) {
          socket?.write(encodeFrame(10, frame.payload));
        }
        return;
      }
      if (frame.opcode === 0) {
        if (fragmentOpcode === undefined) {
          throw new Error("Unexpected Codex app-server continuation frame");
        }
        fragments.push(frame.payload);
        if (
          fragments.reduce((total, fragment) => total + fragment.length, 0) >
          MAX_MESSAGE_BYTES
        ) {
          throw new Error("Codex app-server WebSocket message is too large");
        }
        if (frame.fin) {
          const payload = Buffer.concat(fragments);
          const opcode = fragmentOpcode;
          fragments = [];
          fragmentOpcode = undefined;
          if (opcode === 1) handleMessage(payload);
          else throw new Error("Codex app-server sent a binary message");
        }
        return;
      }
      if ((frame.opcode !== 1 && frame.opcode !== 2) || fragmentOpcode) {
        throw new Error("Invalid Codex app-server data frame");
      }
      if (!frame.fin) {
        fragmentOpcode = frame.opcode;
        fragments = [frame.payload];
      } else if (frame.opcode === 1) {
        handleMessage(frame.payload);
      } else {
        throw new Error("Codex app-server sent a binary message");
      }
    }

    function receive(chunk: Buffer): void {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const frame = decodeFrame(buffer);
          if (!frame) return;
          buffer = Buffer.from(frame.rest);
          handleFrame(frame);
          if (settled) return;
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const rpcRequest = request({
      socketPath,
      path: "/",
      method: "GET",
      headers: {
        Host: "localhost",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });
    rpcRequest.once("error", fail);
    rpcRequest.once("response", (response) => {
      response.resume();
      fail(new Error("Codex app-server refused the WebSocket upgrade"));
    });
    rpcRequest.once("upgrade", (response, upgradedSocket, head) => {
      socket = upgradedSocket;
      if (
        response.statusCode !== 101 ||
        response.headers["sec-websocket-accept"] !== expectedAccept
      ) {
        fail(new Error("Invalid Codex app-server WebSocket upgrade"));
        return;
      }
      socket.on("data", receive);
      socket.on("error", fail);
      socket.on("end", () => {
        fail(new Error("Codex app-server closed the connection"));
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "confuse-desktop",
            title: "Confuse",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      });
      if (head.length > 0) receive(head);
    });
    rpcRequest.end();
  });
}

function hasTrustedHooks(
  result: unknown,
  command: string,
  sourcePath: string,
): boolean {
  if (!isRecord(result) || !Array.isArray(result.data)) return false;
  const hooks = result.data.flatMap((entry) =>
    isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [],
  );
  return CODEX_HOOK_EVENTS.every((event) => {
    const eventName = event.charAt(0).toLowerCase() + event.slice(1);
    return hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.eventName === eventName &&
        hook.handlerType === "command" &&
        hook.command === command &&
        hook.sourcePath === sourcePath &&
        hook.enabled === true &&
        hook.trustStatus === "trusted",
    );
  });
}

export function createCodexTrustChecker(
  options: CodexTrustCheckerOptions = {},
): CodexTrustChecker {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME ?? join(homeDir, ".codex");
  const socketPath = join(
    codexHome,
    "app-server-control",
    "app-server-control.sock",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (command, sourcePath) => {
    try {
      const result = await queryCodexHooks(socketPath, timeoutMs);
      return hasTrustedHooks(result, command, sourcePath);
    } catch {
      return false;
    }
  };
}
