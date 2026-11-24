import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  appendFile,
  stat,
  readdir,
} from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
} from "@deepseek-ai/dsh-session";
import {
  apply as applyJsonlPersistence,
  type JsonlCompression,
} from "@deepseek-ai/dsh-session-persistence-jsonl";
import { readSupervisorConfig } from "./config";
import { discoverJsonlHistorySources } from "./history/discovery";
import { MemorySecretStore } from "./keychain";
import type { OutboxRecord } from "./store";
import { Supervisor } from "./supervisor";
import type {
  LangfuseV6Client,
  NodeLangfuseV6Options,
} from "./telemetry/langfuse-v6";
import { SdkOutboxDispatcher } from "./telemetry/sdk-dispatcher";
import type { TelemetryEvent } from "./telemetry/types";

const directories: string[] = [];
const supervisors: Supervisor[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.stop()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("supervisor Agent integration", () => {
  it("records watermarks, incrementally imports, and normalizes idempotent Unix HTTP hooks", async () => {
    const fixture = await createFixture();
    const delivered: OutboxRecord[] = [];
    fixture.supervisor.setOutboxDispatcher(async (record) => {
      delivered.push(record);
    });
    await fixture.supervisor.start({ runtime: false });
    await writeFile(
      fixture.historyFile,
      `${JSON.stringify({ type: "user", event_id: "before-connect", timestamp: "2026-01-01T00:00:00Z" })}\n`,
    );
    await installFakeKimi(fixture.bin);
    await installFakeDsh(fixture.bin);

    const scan = await invoke(fixture.socketPath, "agents.scan");
    expect(scan.ok).toBe(true);
    const dsh = scan.result.find(
      (agent: { kind: string }) => agent.kind === "deepseek-harness",
    );
    expect(dsh.historySupported).toBe(true);
    expect(dsh.message).not.toContain("history import is unsupported");

    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "kimi-code", importHistory: false }],
    });
    expect(connected.ok).toBe(true);
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store.getJob(connected.result.jobIds[0]).job.state,
    ).toBe("succeeded");
    expect(delivered).toHaveLength(0);

    const preview = await invoke(fixture.socketPath, "history.preview", {
      kinds: ["kimi-code"],
    });
    expect(preview.result[0].sessionCount).toBe(1);
    await appendFile(
      fixture.historyFile,
      `${JSON.stringify({ type: "assistant", event_id: "after-connect", timestamp: "2026-01-02T00:00:00Z" })}\n`,
    );
    const imported = await invoke(fixture.socketPath, "history.start", {
      kinds: ["kimi-code"],
    });
    await fixture.supervisor.jobs.drain();
    await waitFor(() => delivered.length === 1);
    expect(
      fixture.supervisor.store.getJob(imported.result.jobIds[0]).job.state,
    ).toBe("succeeded");
    const historical = delivered[0].payload as TelemetryEvent;
    expect(historical).toMatchObject({
      agent: "kimi-code",
      name: "kimi-code:assistant",
      output: { event_id: "after-connect" },
      metadata: { historical: true },
    });

    const sources = await discoverJsonlHistorySources(
      { kind: "kimi-code", importHistory: false },
      join(fixture.root, "home", ".kimi-code"),
    );
    const cursor = await fixture.supervisor.store.getCursor(sources[0].id);
    expect(cursor).toMatchObject({
      offset: (await stat(fixture.historyFile)).size,
    });
    const duplicateImport = await invoke(fixture.socketPath, "history.start", {
      kinds: ["kimi-code"],
    });
    await fixture.supervisor.jobs.drain();
    const duplicateJob = fixture.supervisor.store.getJob(
      duplicateImport.result.jobIds[0],
    ).job;
    expect(duplicateJob.state).toBe("succeeded");
    expect(duplicateJob.message).toContain("Scanned 0 record(s)");
    expect(delivered.map((record) => record.payload)).toEqual([historical]);

    const envelope = {
      source: "confuse-agent-hook",
      agent: "kimi-code",
      sentAt: "2026-01-03T00:00:00Z",
      payload: {
        hook_event_name: "Stop",
        session_id: "synthetic-live-session",
        turn_id: "turn-1",
        event_id: "event-1",
        model: "synthetic-model",
        usage: { input_tokens: 3, output_tokens: 2 },
        last_assistant_message: "synthetic response",
      },
    };
    const firstHook = await postHook(fixture.socketPath, envelope);
    expect(firstHook.status).toBe(202);
    expect(firstHook.body).toEqual({ accepted: 2 });
    await waitFor(() => delivered.length === 3);
    const generation = delivered
      .map((record) => record.payload as TelemetryEvent)
      .find((event) => event.type === "generation");
    expect(generation).toMatchObject({
      agent: "kimi-code",
      model: "synthetic-model",
      output: "synthetic response",
      usageDetails: { input: 3, output: 2 },
      metadata: { historical: false },
    });

    expect((await postHook(fixture.socketPath, envelope)).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(delivered).toHaveLength(3);
  });

  it.each(["zstd", "none"] as const)(
    "previews and incrementally imports official DSH %s sessions",
    async (compression) => {
      const fixture = await createFixture();
      const delivered: OutboxRecord[] = [];
      fixture.supervisor.setOutboxDispatcher(async (record) => {
        delivered.push(record);
      });
      await createDshHistoryFixture(
        join(fixture.root, "home", ".dsh", "sessions"),
        compression,
      );
      await installFakeDsh(fixture.bin);
      await fixture.supervisor.start({ runtime: false });

      const preview = await invoke(fixture.socketPath, "history.preview", {
        kinds: ["deepseek-harness"],
      });
      expect(preview.result[0]).toMatchObject({
        sessionCount: 1,
        includes: ["turn/end", "turn/start"],
        oldestAt: "2026-01-01T00:00:00.000Z",
        newestAt: "2026-01-01T00:00:01.000Z",
        warnings: [],
      });
      expect(delivered).toHaveLength(0);

      const started = await invoke(fixture.socketPath, "history.start", {
        kinds: ["deepseek-harness"],
      });
      await fixture.supervisor.jobs.drain();
      const job = fixture.supervisor.store.getJob(started.result.jobIds[0]).job;
      expect(job.state).toBe("succeeded");
      expect(job.message).toContain(
        "Scanned 2 record(s); queued 2, duplicates 0",
      );
      await waitFor(() => delivered.length === 2);
      expect(
        delivered.map((record) => record.payload as TelemetryEvent),
      ).toMatchObject([
        {
          agent: "deepseek-harness",
          sessionId: "synthetic-dsh-session",
          name: "deepseek-harness:turn/start",
          metadata: { historical: true, formatVersion: "4", seq: "0" },
        },
        {
          name: "deepseek-harness:turn/end",
          metadata: { historical: true, formatVersion: "4", seq: "1" },
        },
      ]);

      const duplicate = await invoke(fixture.socketPath, "history.start", {
        kinds: ["deepseek-harness"],
      });
      await fixture.supervisor.jobs.drain();
      const duplicateJob = fixture.supervisor.store.getJob(
        duplicate.result.jobIds[0],
      ).job;
      expect(duplicateJob.state).toBe("succeeded");
      expect(duplicateJob.message).toContain("Scanned 0 record(s)");
      expect(delivered).toHaveLength(2);
    },
  );
  it("rejects configuration writes outside the discovered Agent home", async () => {
    const fixture = await createFixture();
    await installFakeKimi(fixture.bin);
    await fixture.supervisor.start({ runtime: false });
    const configPath = join(fixture.root, "outside", "config.toml");
    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "kimi-code", configPath, importHistory: false }],
    });
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store.getJob(connected.result.jobIds[0]).job.state,
    ).toBe("failed");
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SdkOutboxDispatcher", () => {
  it("reads local project keys from the secret store and flushes through the SDK", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("LANGFUSE_INIT_PROJECT_PUBLIC_KEY", "pk-lf-synthetic");
    await secrets.set("LANGFUSE_INIT_PROJECT_SECRET_KEY", "sk-lf-synthetic");
    const client = new FakeClient();
    let options: NodeLangfuseV6Options | undefined;
    const dispatcher = new SdkOutboxDispatcher(
      secrets,
      "http://127.0.0.1:3000",
      (received) => {
        options = received;
        return client;
      },
    );
    const event = telemetryEvent();
    await dispatcher.dispatch({
      id: event.id,
      kind: "telemetry",
      payload: event,
      attempts: 0,
      nextAttemptAt: event.timestamp!,
      createdAt: event.timestamp!,
    });

    expect(options).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      publicKey: "pk-lf-synthetic",
      secretKey: "sk-lf-synthetic",
      environment: "confuse-desktop",
    });
    expect(client.flushes).toBe(1);
    await dispatcher.close();
    expect(client.shutdowns).toBe(1);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "confuse-rt-"));
  directories.push(root);
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const applications = join(root, "Applications");
  const historyDirectory = join(home, ".kimi-code", "sessions", "session-1");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(applications, { recursive: true }),
    mkdir(historyDirectory, { recursive: true }),
  ]);
  const socketPath = join(stateDir, "supervisor.sock");
  const supervisor = new Supervisor(
    readSupervisorConfig({
      CONFUSE_STATE_DIR: stateDir,
      CONFUSE_OUTBOX_POLL_MS: "100000",
    }),
    {
      secrets: new MemorySecretStore(),
      agentContext: {
        homeDir: home,
        env: { HOME: home, PATH: bin },
        applicationDirs: [applications],
      },
    },
  );
  supervisors.push(supervisor);
  return {
    supervisor,
    socketPath,
    bin,
    root,
    historyFile: join(historyDirectory, "wire.jsonl"),
  };
}

async function installFakeKimi(bin: string): Promise<void> {
  const executable = join(bin, "kimi");
  await writeFile(executable, "#!/bin/sh\necho 'kimi 1.2.3'\n");
  await chmod(executable, 0o755);
}

async function installFakeDsh(bin: string): Promise<void> {
  const executable = join(bin, "dsh");
  await writeFile(executable, "#!/bin/sh\necho 'dsh 0.2.2-rc.5'\n");
  await chmod(executable, 0o755);
}

async function createDshHistoryFixture(
  root: string,
  compression: JsonlCompression,
): Promise<void> {
  const context = new Context();
  try {
    await context.plugin(applyJsonlPersistence, { root, compression });
    const handle = await context.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId("synthetic-dsh-session"),
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      cwd: root,
      isSeeded: false,
      delegationDepth: 0,
    });
    try {
      await handle.append([
        {
          type: "turn/start",
          seq: SessionSeq(0),
          time: Date.parse("2026-01-01T00:00:00.000Z"),
          data: { turn: 1 },
        },
        {
          type: "turn/end",
          seq: SessionSeq(1),
          time: Date.parse("2026-01-01T00:00:01.000Z"),
          data: { turn: 1, reason: { kind: "completed" } },
        },
      ]);
      await handle.flush();
    } finally {
      await handle.close();
    }
    const files = await readdir(root, { recursive: true });
    const suffix = compression === "zstd" ? ".jsonl.zstd" : ".jsonl";
    expect(files.some((file) => file.endsWith(`v4${suffix}`))).toBe(true);
  } finally {
    await context.fiber.dispose();
  }
}

async function invoke(
  socketPath: string,
  channel: string,
  payload?: unknown,
): Promise<any> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const response = new Promise<any>((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id === id) {
          socket.end();
          resolve(message);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify({ id, channel, payload })}\n`);
  return response;
}

async function postHook(
  socketPath: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: "/v1/agent-events",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    call.once("error", reject);
    call.end(body);
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true");
}

class FakeClient implements LangfuseV6Client {
  flushes = 0;
  shutdowns = 0;

  setObservationIds(): void {}
  propagateAttributes<T>(_attributes: unknown, callback: () => T): T {
    return callback();
  }
  startObservation() {
    return { end: () => undefined };
  }
  async forceFlush(): Promise<void> {
    this.flushes += 1;
  }
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

function telemetryEvent(): TelemetryEvent {
  return {
    id: "synthetic-event",
    traceId: "1".repeat(32),
    observationId: "2".repeat(16),
    agent: "kimi-code",
    sessionId: "synthetic-session",
    name: "synthetic-event",
    type: "event",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}
