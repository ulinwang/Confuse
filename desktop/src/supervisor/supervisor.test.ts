import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    for (const client of clients) client.close();
    await Promise.all(supervisors.map((supervisor) => supervisor.stop(false)));
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    supervisors.length = 0;
    clients.length = 0;
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
