import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./config";
import type { SupervisorEvents } from "./events";
import { RequestError, SupervisorRouter } from "./router";
import type { SupervisorResponse } from "../shared/protocol";

const MAXIMUM_LINE_BYTES = 64 * 1024;
const MAXIMUM_HEADER_BYTES = 16 * 1024;
const MAXIMUM_EVENT_BYTES = 8 * 1024 * 1024;

export type AgentEventHandler = (payload: unknown) => Promise<number>;

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(false);
      else reject(error);
    });
  });
}

export class SupervisorSocketServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private readonly rpcClients = new Set<Socket>();
  private readonly unsubscribe: () => void;
  private agentEventHandler?: AgentEventHandler;

  constructor(
    private readonly socketPath: string,
    private readonly router: SupervisorRouter,
    events: SupervisorEvents,
    agentEventHandler?: AgentEventHandler,
  ) {
    this.agentEventHandler = agentEventHandler;
    this.server = createServer((socket) => this.accept(socket));
    this.unsubscribe = events.subscribe((event) => {
      const line = `${JSON.stringify(event)}\n`;
      for (const client of this.rpcClients) {
        if (client.writable && client.writableLength < 1_048_576)
          client.write(line);
      }
    });
  }

  setAgentEventHandler(handler: AgentEventHandler | undefined): void {
    this.agentEventHandler = handler;
  }

  async listen(): Promise<void> {
    ensurePrivateDirectory(dirname(this.socketPath));
    if (Buffer.byteLength(this.socketPath) >= 100)
      throw new Error("Supervisor socket path is too long");
    try {
      const stat = lstatSync(this.socketPath);
      if (!stat.isSocket() || stat.isSymbolicLink()) {
        throw new Error("Refusing to replace a non-socket desktop IPC path");
      }
      if (await socketIsActive(this.socketPath))
        throw new Error("Another supervisor is already running");
      unlinkSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => reject(cause);
      this.server.once("error", error);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", error);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setNoDelay(true);
    let buffer: Buffer = Buffer.alloc(0);
    let protocol: "unknown" | "rpc" | "http" = "unknown";
    let handled = false;

    const remove = () => {
      this.clients.delete(socket);
      this.rpcClients.delete(socket);
    };
    socket.on("close", remove);
    socket.on("error", remove);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (protocol === "unknown") {
        const prefix = buffer.toString("utf8", 0, Math.min(buffer.length, 16));
        if (/^(?:POST|GET|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(prefix)) {
          protocol = "http";
        } else if (
          /^[PGUDHO]/.test(prefix) &&
          !prefix.includes(" ") &&
          buffer.length < 16
        ) {
          return;
        } else {
          protocol = "rpc";
          this.rpcClients.add(socket);
        }
      }

      if (protocol === "http") {
        const result = parseHttpRequest(buffer);
        if (result.status === "incomplete") return;
        handled = true;
        if (result.status === "error") {
          this.writeHttp(socket, result.code, { error: result.message });
          return;
        }
        void this.respondToAgentEvent(
          socket,
          result.method,
          result.path,
          result.body,
        );
        return;
      }

      if (buffer.length > MAXIMUM_LINE_BYTES && !buffer.includes(0x0a)) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        if (line.trim()) void this.respond(socket, line);
        newline = buffer.indexOf(0x0a);
      }
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let id = "";
    try {
      const value: unknown = JSON.parse(line);
      if (
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string"
      ) {
        id = value.id;
      }
      const result = await this.router.handle(value);
      this.write(socket, { id, ok: true, result });
    } catch (error) {
      const response: SupervisorResponse = {
        id,
        ok: false,
        error: {
          code: error instanceof RequestError ? error.code : "INTERNAL_ERROR",
          message:
            error instanceof RequestError
              ? error.message
              : "The supervisor could not complete the request",
        },
      };
      this.write(socket, response);
    }
  }

  private async respondToAgentEvent(
    socket: Socket,
    method: string,
    path: string,
    body: Buffer,
  ): Promise<void> {
    if (path !== "/v1/agent-events") {
      this.writeHttp(socket, 404, { error: "Not found" });
      return;
    }
    if (method !== "POST") {
      this.writeHttp(socket, 405, { error: "Method not allowed" });
      return;
    }
    if (!this.agentEventHandler) {
      this.writeHttp(socket, 503, { error: "Agent ingestion is unavailable" });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      this.writeHttp(socket, 400, { error: "Invalid JSON" });
      return;
    }
    try {
      const accepted = await this.agentEventHandler(payload);
      if (accepted === 0) {
        this.writeHttp(socket, 400, { error: "Invalid Agent event" });
        return;
      }
      this.writeHttp(socket, 202, { accepted });
    } catch {
      this.writeHttp(socket, 500, { error: "Agent event could not be queued" });
    }
  }

  private write(socket: Socket, response: SupervisorResponse): void {
    if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
  }

  private writeHttp(socket: Socket, status: number, value: unknown): void {
    if (!socket.writable) return;
    const body = JSON.stringify(value);
    const reason =
      {
        202: "Accepted",
        400: "Bad Request",
        404: "Not Found",
        405: "Method Not Allowed",
        411: "Length Required",
        413: "Content Too Large",
        415: "Unsupported Media Type",
        431: "Request Header Fields Too Large",
        500: "Internal Server Error",
        503: "Service Unavailable",
      }[status] ?? "Error";
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.rpcClients.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    try {
      if (lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type HttpParseResult =
  | { status: "incomplete" }
  | { status: "error"; code: number; message: string }
  | { status: "complete"; method: string; path: string; body: Buffer };

function parseHttpRequest(buffer: Buffer): HttpParseResult {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return buffer.length > MAXIMUM_HEADER_BYTES
      ? { status: "error", code: 431, message: "Headers too large" }
      : { status: "incomplete" };
  }
  if (headerEnd > MAXIMUM_HEADER_BYTES) {
    return { status: "error", code: 431, message: "Headers too large" };
  }
  const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const request = lines[0]?.match(
    /^(POST|GET|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/1\.1$/,
  );
  if (!request)
    return { status: "error", code: 400, message: "Invalid request" };
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return { status: "error", code: 400, message: "Invalid headers" };
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) {
      return { status: "error", code: 400, message: "Duplicate header" };
    }
    headers.set(name, value);
  }
  if (headers.has("transfer-encoding")) {
    return {
      status: "error",
      code: 400,
      message: "Content-Length is required",
    };
  }
  const lengthText = headers.get("content-length");
  if (!lengthText || !/^\d+$/.test(lengthText)) {
    return {
      status: "error",
      code: 411,
      message: "Content-Length is required",
    };
  }
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || length > MAXIMUM_EVENT_BYTES) {
    return { status: "error", code: 413, message: "Event is too large" };
  }
  const contentType = headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    return { status: "error", code: 415, message: "JSON is required" };
  }
  const bodyStart = headerEnd + 4;
  if (buffer.length - bodyStart < length) return { status: "incomplete" };
  return {
    status: "complete",
    method: request[1],
    path: request[2],
    body: buffer.subarray(bodyStart, bodyStart + length),
  };
}
