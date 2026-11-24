import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import type { SupervisorConfig } from "./config";
import type { DesktopSecrets } from "./keychain";
import type { ProcessRunner } from "./process";

const MINIMUM_MEMORY_BYTES = 4 * 1024 ** 3;
const MINIMUM_DISK_BYTES = 2 * 1024 ** 3;

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Health check cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ECONNREFUSED" ||
        error.code === "EHOSTUNREACH" ||
        error.code === "ETIMEDOUT"
      ) {
        finish(false);
      } else {
        reject(error);
      }
    });
  });
}

export class HealthChecker {
  constructor(
    private readonly config: SupervisorConfig,
    private readonly runner: ProcessRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async preflight(
    options: { allowOccupiedPorts?: boolean } = {},
  ): Promise<void> {
    await this.runner.run("/usr/local/bin/docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const info = await this.runner.run("/usr/local/bin/docker", [
      "info",
      "--format",
      "{{json .}}",
    ]);
    const details = JSON.parse(info.stdout) as {
      NCPU?: number;
      MemTotal?: number;
    };
    if (
      (details.NCPU ?? 0) < 2 ||
      (details.MemTotal ?? 0) < MINIMUM_MEMORY_BYTES
    ) {
      throw new Error(
        "Docker needs at least 2 CPUs and 4 GiB of memory for Confuse",
      );
    }
    const disk = await statfs(this.config.stateDir);
    if (Number(disk.bavail) * Number(disk.bsize) < MINIMUM_DISK_BYTES) {
      throw new Error("Confuse needs at least 2 GiB of free disk space");
    }
    if (options.allowOccupiedPorts) return;
    for (const port of [
      this.config.webPort,
      this.config.minioPort,
      this.config.minioConsolePort,
    ]) {
      if (await portIsOpen(port)) {
        throw new Error(
          `Port ${port} is already in use; Confuse did not change the owning process`,
        );
      }
    }
  }

  async webIsReady(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(
        `${this.config.webUrl}/api/public/health`,
        {
          signal: AbortSignal.timeout(2_000),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.webIsReady()) return;
      await sleep(1_000, signal);
    }
    throw new Error(
      "Confuse Web did not become ready before the startup deadline",
    );
  }

  async verifyIngestion(secrets: DesktopSecrets): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const response = await this.fetchImpl(
      `${this.config.webUrl}/api/public/ingestion`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(
            `${secrets.LANGFUSE_INIT_PROJECT_PUBLIC_KEY}:${secrets.LANGFUSE_INIT_PROJECT_SECRET_KEY}`,
          ).toString("base64")}`,
        },
        body: JSON.stringify({
          batch: [
            {
              id: randomUUID(),
              type: "trace-create",
              timestamp: now,
              body: {
                id,
                name: "Confuse startup check",
                timestamp: now,
                metadata: { source: "desktop-supervisor", synthetic: true },
              },
            },
          ],
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Synthetic ingestion failed with HTTP ${response.status}`,
      );
  }
}
