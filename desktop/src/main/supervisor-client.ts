import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type {
  DesktopChannel,
  DesktopEventMap,
  DesktopRequest,
  DesktopResponse,
} from "../shared/contracts";
import {
  parseSupervisorMessage,
  type SupervisorRequest,
  type SupervisorResponse,
} from "../shared/protocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class SupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupervisorError";
  }
}

export class SupervisorClient extends EventEmitter {
  private socket: Socket | null = null;
  private connection: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private started = false;

  constructor(
    private readonly socketPath: string,
    private readonly reconnectDelayMs = 1_000,
    private readonly requestTimeoutMs = 120_000,
  ) {
    super();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.connect().catch(() => undefined);
  }

  close(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error("Supervisor client closed"));
    this.socket?.destroy();
    this.socket = null;
    this.buffer = "";
  }

  onConnected(listener: () => void): () => void {
    this.on("connected", listener);
    return () => this.off("connected", listener);
  }

  onEvent<C extends keyof DesktopEventMap>(
    channel: C,
    listener: (event: DesktopEventMap[C]) => void,
  ): () => void {
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  async request<C extends DesktopChannel>(
    channel: C,
    payload: DesktopRequest<C>,
  ): Promise<DesktopResponse<C>> {
    if (!this.started) {
      throw new Error("Supervisor client is not running");
    }
    await this.connect();

    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("Supervisor is not connected");
    }

    const id = randomUUID();
    const request: SupervisorRequest = { id, channel, payload };

    return new Promise<DesktopResponse<C>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Supervisor request timed out: ${channel}`));
      }, this.requestTimeoutMs);
      timeout.unref();

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async connect(): Promise<void> {
    if (!this.started) {
      throw new Error("Supervisor client is not running");
    }
    if (this.socket?.readyState === "open" && !this.socket.destroyed) {
      return;
    }
    if (this.connection) {
      return this.connection;
    }

    const connection = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      this.buffer = "";
      let settled = false;

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        settled = true;
        this.emit("connected");
        resolve();
      });
      socket.on("data", (data: string) => {
        this.receive(socket, data);
      });
      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("close", () => {
        this.emit("close");
        if (this.socket === socket) {
          this.socket = null;
          this.buffer = "";
          this.rejectPending(new Error("Supervisor connection closed"));
          this.scheduleReconnect();
        }
        if (!settled) {
          settled = true;
          reject(new Error("Supervisor connection closed before it was ready"));
        }
      });
    });

    this.connection = connection;
    try {
      await connection;
    } finally {
      if (this.connection === connection) {
        this.connection = null;
      }
    }
  }

  private receive(socket: Socket, data: string): void {
    if (socket !== this.socket) {
      return;
    }

    this.buffer += data;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      try {
        const message = parseSupervisorMessage(line);
        if ("event" in message) {
          this.emit(message.event, message.payload);
        } else {
          this.handleResponse(message);
        }
      } catch (error) {
        socket.destroy(
          error instanceof Error
            ? error
            : new Error("Invalid supervisor response"),
        );
        return;
      }
    }
  }

  private handleResponse(response: SupervisorResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new SupervisorError(
          response.error?.code ?? "UNKNOWN_ERROR",
          response.error?.message ?? "Supervisor request failed",
        ),
      );
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }
}
