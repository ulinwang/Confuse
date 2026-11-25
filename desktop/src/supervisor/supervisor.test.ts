import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeAdapter } from "./adapters";
import { readSupervisorConfig } from "./config";
import { MemorySecretStore } from "./keychain";
import type { ProcessRunner } from "./process";
import { Supervisor } from "./supervisor";

class Client {
  private socket?: Socket;
  private buffer = "";
  private readonly pending = new Map<string, (value: any) => void>();
  readonly events: any[] = [];

  async connect(path: string): Promise<void> {
    this.socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", resolve);
      this.socket!.once("error", reject);
    });
    this.socket!.setEncoding("utf8");
    this.socket!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        if (message.event) this.events.push(message);
        else this.pending.get(message.id)?.(message);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  request(channel: string, payload?: unknown): Promise<any> {
    const id = randomUUID();
    const response = new Promise<any>((resolve) =>
      this.pending.set(id, resolve),
    );
    this.socket!.write(`${JSON.stringify({ id, channel, payload })}\n`);
    return response;
  }

  close(): void {
    this.socket?.destroy();
  }
}

const runners: ProcessRunner = {
  async run() {
    return { stdout: "", stderr: "" };
  },
};

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true");
}

describe("supervisor IPC", () => {
  const directories: string[] = [];
  const supervisors: Supervisor[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const client of clients) client.close();
    await Promise.all(
      supervisors.map((supervisor) =>
        supervisor.stop(false).catch(() => undefined),
      ),
    );
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    supervisors.length = 0;
    clients.length = 0;
    vi.restoreAllMocks();
  });

  async function createSupervisor(onStopped?: () => void) {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-supervisor-"));
    directories.push(stateDir);
    const supervisor = new Supervisor(
      readSupervisorConfig({
        CONFUSE_STATE_DIR: stateDir,
        CONFUSE_OUTBOX_POLL_MS: "100000",
      }),
      {
        runner: runners,
        secrets: new MemorySecretStore(),
        agentContext: {
          homeDir: stateDir,
          env: { HOME: stateDir, PATH: join(stateDir, "bin") },
          applicationDirs: [join(stateDir, "Applications")],
        },
        onStopped,
      },
    );
    supervisors.push(supervisor);
    await supervisor.start({ runtime: false });
    const client = new Client();
    clients.push(client);
    await client.connect(join(stateDir, "supervisor.sock"));
    return { supervisor, client, stateDir };
  }

  async function startRuntimeWithFailingDocker(fetchImpl: typeof fetch) {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-runtime-retry-"));
    directories.push(stateDir);
    const failingRunner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "version")
          throw new Error("Docker Engine is unavailable");
        return { stdout: "", stderr: "" };
      },
    };
    const supervisor = new Supervisor(
      readSupervisorConfig({ CONFUSE_STATE_DIR: stateDir }),
      {
        runner: failingRunner,
        secrets: new MemorySecretStore(),
        fetch: fetchImpl,
      },
    );
    supervisors.push(supervisor);
    await supervisor.start();
    return { supervisor, stateDir };
  }

  it("validates requests, emits job events, and persists onboarding state", async () => {
    const { supervisor, client, stateDir } = await createSupervisor();
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "supervisor.sock")).mode & 0o777).toBe(
      0o600,
    );
    const scan = await client.request("agents.scan");
    expect(scan.ok).toBe(true);
    expect(scan.result.map((agent: any) => agent.kind)).toEqual([
      "kimi-code",
      "chatgpt-codex",
      "claude-code",
      "deepseek-harness",
    ]);
    expect(
      (await client.request("desktop.complete-onboarding", { selections: [] }))
        .ok,
    ).toBe(true);
    expect(
      (await client.request("notifications.mark-read", { ids: "invalid" }))
        .error.code,
    ).toBe("INVALID_REQUEST");

    let connected = false;
    const adapter: AgentRuntimeAdapter = {
      async scan() {
        return [];
      },
      async connect() {
        connected = true;
        return { message: "Connected" };
      },
      async previewHistory() {
        return [];
      },
      async importHistory() {
        return { message: "Imported" };
      },
    };
    supervisor.setAgentAdapter(adapter);
    const response = await client.request("desktop.complete-onboarding", {
      selections: [{ kind: "kimi-code", importHistory: false }],
    });
    expect(response.ok).toBe(true);
    expect(response.result.jobIds).toHaveLength(1);
    await waitFor(
      () =>
        connected &&
        client.events.some((event) => event.payload?.state === "succeeded"),
    );
    const state = await client.request("desktop.get-state");
    expect(state.result.firstRunComplete).toBe(true);
    expect(
      client.events.some((event) => event.event === "desktop.job-changed"),
    ).toBe(true);
  });

  it("keeps IPC available and persists a notification when runtime startup fails", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-degraded-"));
    directories.push(stateDir);
    const failingRunner: ProcessRunner = {
      async run(_command, args) {
        if (args[0] === "version")
          throw new Error("Docker Engine is unavailable");
        return { stdout: "", stderr: "" };
      },
    };
    const supervisor = new Supervisor(
      readSupervisorConfig({ CONFUSE_STATE_DIR: stateDir }),
      {
        runner: failingRunner,
        secrets: new MemorySecretStore(),
        fetch: async () => new Response(null, { status: 503 }),
      },
    );
    supervisors.push(supervisor);
    await supervisor.start();
    await waitFor(() =>
      supervisor.store
        .listNotifications()
        .some(
          (notification) =>
            notification.title === "Confuse runtime needs attention",
        ),
    );
    expect(supervisor.store.getDesktopState().runtime).toBe("degraded");
    const client = new Client();
    clients.push(client);
    await client.connect(join(stateDir, "supervisor.sock"));
    expect((await client.request("desktop.get-state")).ok).toBe(true);
  });

  it("retries a degraded runtime with one flight and no duplicate notifications", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    let healthy = false;
    let resolveRetry!: (response: Response) => void;
    const { supervisor } = await startRuntimeWithFailingDocker(async () => {
      healthChecks++;
      if (healthChecks === 2) {
        return new Promise<Response>((resolve) => {
          resolveRetry = resolve;
        });
      }
      return healthy
        ? Response.json({ status: "ok", service: "confuse" })
        : new Response(null, { status: 503 });
    });
    const notificationCount = () =>
      supervisor.store
        .listNotifications()
        .filter(
          (notification) =>
            notification.title === "Confuse runtime needs attention",
        ).length;

    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.store.getDesktopState().runtime).toBe("degraded");
    expect(notificationCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(healthChecks).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(healthChecks).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthChecks).toBe(2);
    resolveRetry(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationCount()).toBe(1);

    healthy = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(healthChecks).toBe(3);
    expect(supervisor.store.getDesktopState().runtime).toBe("ready");
    expect(notificationCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthChecks).toBe(3);
  });

  it.each(["stop", "quit"] as const)(
    "cancels a scheduled runtime retry on %s",
    async (action) => {
      vi.useFakeTimers();
      let healthChecks = 0;
      const { supervisor, stateDir } = await startRuntimeWithFailingDocker(
        async () => {
          healthChecks++;
          return new Response(null, { status: 503 });
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor.store.getDesktopState().runtime).toBe("degraded");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(healthChecks).toBe(2);

      if (action === "stop") {
        await supervisor.stop(false);
      } else {
        const client = new Client();
        clients.push(client);
        await client.connect(join(stateDir, "supervisor.sock"));
        expect((await client.request("desktop.quit")).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(25);
      }

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(healthChecks).toBe(2);
    },
  );

  it("does not wait for an aborted runtime startup before stopping", async () => {
    let markStartupStarted!: () => void;
    const startupStarted = new Promise<void>((resolve) => {
      markStartupStarted = resolve;
    });
    let rejectStartup!: (error: Error) => void;
    const hangingRunner: ProcessRunner = {
      async run(_command, args) {
        if (args.includes("ps"))
          return { stdout: "langfuse-web\n", stderr: "" };
        if (args.includes("info"))
          return {
            stdout: JSON.stringify({ NCPU: 2, MemTotal: 4 * 1024 ** 3 }),
            stderr: "",
          };
        if (args.includes("up")) {
          markStartupStarted();
          return new Promise((_, reject) => {
            rejectStartup = reject;
          });
        }
        return { stdout: "", stderr: "" };
      },
    };
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-startup-stop-"));
    directories.push(stateDir);
    const supervisor = new Supervisor(
      readSupervisorConfig({ CONFUSE_STATE_DIR: stateDir }),
      {
        runner: hangingRunner,
        secrets: new MemorySecretStore(),
        fetch: async () => new Response(null, { status: 503 }),
      },
    );
    supervisors.push(supervisor);
    await supervisor.start();
    await startupStarted;
    const client = new Client();
    clients.push(client);
    await client.connect(join(stateDir, "supervisor.sock"));

    const quitting = client.request("desktop.quit");
    const response = await Promise.race([
      quitting,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    rejectStartup(new Error("Startup aborted"));
    if (response === "pending") await quitting;
    await supervisor.stop(false);

    expect(response).not.toBe("pending");
    expect(response.ok).toBe(true);
  });

  it("observes finalization failures after the quit response window", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { supervisor, client } = await createSupervisor(() => {
      throw new Error("Finalization failed");
    });

    const response = await client.request("desktop.quit");
    expect(response.ok).toBe(true);
    await waitFor(() =>
      consoleError.mock.calls.some((call) =>
        String(call[0]).includes("Confuse supervisor shutdown failed"),
      ),
    );
    await expect(supervisor.stop(false)).rejects.toThrow("Finalization failed");
  });

  it("stops only the confuse Compose project before acknowledging full quit", async () => {
    const calls: string[][] = [];
    const recordingRunner: ProcessRunner = {
      async run(_command, args) {
        calls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    };
    let stopped!: () => void;
    const stoppedPromise = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-quit-"));
    directories.push(stateDir);
    const supervisor = new Supervisor(
      readSupervisorConfig({ CONFUSE_STATE_DIR: stateDir }),
      {
        runner: recordingRunner,
        secrets: new MemorySecretStore(),
        onStopped: () => stopped(),
      },
    );
    supervisors.push(supervisor);
    await supervisor.start({ runtime: false });
    const client = new Client();
    clients.push(client);
    await client.connect(join(stateDir, "supervisor.sock"));
    const response = await client.request("desktop.quit");
    expect(response.ok).toBe(true);
    await stoppedPromise;
    const down = calls.find((args) => args.includes("down"));
    expect(down?.slice(0, 5)).toEqual([
      "compose",
      "--project-name",
      "confuse",
      "--file",
      down[4],
    ]);
    expect(down).not.toContain("--volumes");
    expect(down).not.toContain("-v");
  });
});
