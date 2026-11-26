import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  appendFile,
  stat,
  readdir,
  readFile,
} from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { AgentProjects } from "./agent-projects";
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
    const cursor = await fixture.supervisor.store.getCursor(
      `confuse-kimi-code:${sources[0].id}`,
    );
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
  it("resumes a trusted Codex connection once and imports its history", async () => {
    let trusted = false;
    const fixture = await createFixture({
      isCodexHookTrusted: async () => trusted,
      waitingCodexJobPollMs: 10,
    });
    await installFakeCodex(fixture.applications);
    const historyFile = join(fixture.home, ".codex", "history.jsonl");
    await mkdir(join(fixture.home, ".codex"), { recursive: true });
    await writeFile(
      historyFile,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          thread_id: "synthetic-thread",
          turn_id: "turn-1",
          item: { type: "function_call", id: "item-1", name: "synthetic_tool" },
        },
      })}\n`,
    );
    const delivered: OutboxRecord[] = [];
    fixture.supervisor.setOutboxDispatcher(async (record) => {
      delivered.push(record);
    });
    await fixture.supervisor.start({ runtime: false });

    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "chatgpt-codex", importHistory: true }],
    });
    await fixture.supervisor.jobs.drain();
    const waitingId = connected.result.jobIds[0] as string;
    expect(fixture.supervisor.store.getJob(waitingId).job.state).toBe(
      "waiting-for-review",
    );
    expect(delivered).toHaveLength(0);

    trusted = true;
    await waitFor(() =>
      fixture.supervisor.store
        .listJobs()
        .some(
          (job) =>
            job.kind === "connect" &&
            job.id !== waitingId &&
            job.state === "succeeded",
        ),
    );
    await fixture.supervisor.jobs.drain();
    await waitFor(() => delivered.length === 1);

    expect(fixture.supervisor.store.getJob(waitingId).job.state).toBe(
      "cancelled",
    );
    expect(delivered[0].payload).toMatchObject({
      agent: "chatgpt-codex",
      sessionId: "synthetic-thread",
      metadata: { historical: true },
    });
    const recoveredJobs = fixture.supervisor.store
      .listJobs()
      .filter((job) => job.kind === "connect");
    expect(recoveredJobs).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store
        .listJobs()
        .filter((job) => job.kind === "connect"),
    ).toHaveLength(2);
    expect(delivered).toHaveLength(1);
  });

  it("uses only a validated new Codex hook as recovery evidence", async () => {
    let trusted = false;
    const fixture = await createFixture({
      isCodexHookTrusted: async () => trusted,
      waitingCodexJobPollMs: 100000,
    });
    await installFakeCodex(fixture.applications);
    const historyFile = join(fixture.home, ".codex", "history.jsonl");
    await mkdir(join(fixture.home, ".codex"), { recursive: true });
    await writeFile(
      historyFile,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          thread_id: "synthetic-hook-thread",
          turn_id: "turn-1",
          item: { type: "function_call", id: "item-1", name: "synthetic_tool" },
        },
      })}\n`,
    );
    const delivered: OutboxRecord[] = [];
    fixture.supervisor.setOutboxDispatcher(async (record) => {
      delivered.push(record);
    });
    await fixture.supervisor.start({ runtime: false });
    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "chatgpt-codex", importHistory: true }],
    });
    await fixture.supervisor.jobs.drain();
    const waitingId = connected.result.jobIds[0] as string;

    expect(
      (
        await postHook(fixture.socketPath, {
          source: "confuse-agent-hook",
          agent: "chatgpt-codex",
          payload: { hook_event_name: "SessionStart" },
        })
      ).body,
    ).toEqual({ error: "Invalid Agent event" });
    await fixture.supervisor.jobs.drain();
    expect(fixture.supervisor.store.listJobs()).toHaveLength(1);

    trusted = true;
    const envelope = {
      source: "confuse-agent-hook",
      agent: "chatgpt-codex",
      payload: {
        hook_event_name: "SessionStart",
        session_id: "synthetic-live-thread",
        event_id: "event-1",
      },
    };
    expect((await postHook(fixture.socketPath, envelope)).body).toEqual({
      accepted: 1,
    });
    await fixture.supervisor.jobs.drain();
    await waitFor(() =>
      delivered.some((record) => {
        const event = record.payload as TelemetryEvent;
        return (
          event.agent === "chatgpt-codex" && event.metadata?.historical === true
        );
      }),
    );
    expect(fixture.supervisor.store.getJob(waitingId).job.state).toBe(
      "cancelled",
    );
    expect(
      fixture.supervisor.store
        .listJobs()
        .filter((job) => job.kind === "connect"),
    ).toHaveLength(2);

    expect((await postHook(fixture.socketPath, envelope)).body).toEqual({
      accepted: 1,
    });
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store
        .listJobs()
        .filter((job) => job.kind === "connect"),
    ).toHaveLength(2);
    expect(
      delivered.filter(
        (record) =>
          (record.payload as TelemetryEvent).metadata?.historical === true,
      ),
    ).toHaveLength(1);
  });

  it("does not reuse Codex hook evidence recorded without a waiting job", async () => {
    const fixture = await createFixture({
      isCodexHookTrusted: async () => false,
      waitingCodexJobPollMs: 100000,
    });
    await installFakeCodex(fixture.applications);
    await fixture.supervisor.start({ runtime: false });

    expect(
      (await postHook(fixture.socketPath, codexHookEnvelope("stale-event")))
        .body,
    ).toEqual({ accepted: 1 });
    await fixture.supervisor.jobs.drain();

    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "chatgpt-codex", importHistory: false }],
    });
    await fixture.supervisor.jobs.drain();
    const waitingId = connected.result.jobIds[0] as string;
    const waiting = fixture.supervisor.store.getJob(waitingId).job;
    expect(waiting.state, waiting.message).toBe("waiting-for-review");

    await postHook(fixture.socketPath, codexHookEnvelope("stale-event"));
    await postHook(fixture.socketPath, codexHookEnvelope("current-event"));
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store
        .listJobs()
        .filter((job) => job.kind === "connect"),
    ).toHaveLength(1);
  });

  it("rechecks current Codex trust when execution evidence resumes a job", async () => {
    let trusted = false;
    let revokeOnNextCheck = false;
    const fixture = await createFixture({
      isCodexHookTrusted: async () => {
        const current = trusted;
        if (revokeOnNextCheck) {
          trusted = false;
          revokeOnNextCheck = false;
        }
        return current;
      },
      waitingCodexJobPollMs: 100000,
    });
    await installFakeCodex(fixture.applications);
    await fixture.supervisor.start({ runtime: false });
    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "chatgpt-codex", importHistory: false }],
    });
    await fixture.supervisor.jobs.drain();
    const waitingId = connected.result.jobIds[0] as string;

    trusted = true;
    revokeOnNextCheck = true;
    await postHook(fixture.socketPath, codexHookEnvelope("execution-event"));
    await fixture.supervisor.jobs.drain();

    expect(fixture.supervisor.store.getJob(waitingId).job.state).toBe(
      "cancelled",
    );
    const connectJobs = fixture.supervisor.store
      .listJobs()
      .filter((job) => job.kind === "connect");
    expect(connectJobs).toHaveLength(2);
    const retried = connectJobs.find((job) => job.id !== waitingId);
    expect(retried?.state, retried?.message).toBe("waiting-for-review");

    await postHook(fixture.socketPath, codexHookEnvelope("untrusted-event"));
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store
        .listJobs()
        .filter((job) => job.kind === "connect"),
    ).toHaveLength(2);
  });

  it("keeps Codex waiting after a watermark failure until review succeeds", async () => {
    let trusted = false;
    const fixture = await createFixture({
      isCodexHookTrusted: async () => trusted,
      waitingCodexJobPollMs: 10,
    });
    await installFakeCodex(fixture.applications);
    await mkdir(join(fixture.home, ".codex"), { recursive: true });
    await writeFile(
      join(fixture.home, ".codex", "history.jsonl"),
      `${JSON.stringify({
        type: "response_item",
        payload: {
          thread_id: "synthetic-watermark-thread",
          turn_id: "turn-1",
          item: { type: "function_call", id: "item-1", name: "synthetic_tool" },
        },
      })}\n`,
    );
    await fixture.supervisor.start({ runtime: false });
    vi.spyOn(fixture.supervisor.store, "getCursor").mockRejectedValueOnce(
      new Error("synthetic watermark failure"),
    );

    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "chatgpt-codex", importHistory: false }],
    });
    await fixture.supervisor.jobs.drain();
    const waitingId = connected.result.jobIds[0] as string;
    const waiting = fixture.supervisor.store.getJob(waitingId).job;
    expect(waiting.state).toBe("waiting-for-review");
    expect(waiting.message).toContain("synthetic watermark failure");
    expect(waiting.message).not.toContain("Live capture is configured");

    trusted = true;
    await waitFor(() =>
      fixture.supervisor.store
        .listJobs()
        .some((job) => job.id !== waitingId && job.state === "succeeded"),
    );
    await fixture.supervisor.jobs.drain();
    expect(fixture.supervisor.store.getJob(waitingId).job.state).toBe(
      "cancelled",
    );
    const recovered = fixture.supervisor.store
      .listJobs()
      .find((job) => job.id !== waitingId && job.kind === "connect");
    expect(recovered?.message).toContain("History starts after");
  });

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

describe("organization and cleanup lifecycle", () => {
  it("requires an organization before changing Agent configuration", async () => {
    const fixture = await createFixture();
    await installFakeKimi(fixture.bin);
    await fixture.supervisor.start({ runtime: false });
    fixture.supervisor.store.resetIntegrations();

    const denied = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "kimi-code", importHistory: false }],
    });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("ORGANIZATION_REQUIRED");
    expect(fixture.supervisor.store.listJobs()).toHaveLength(0);

    const organization = await invoke(
      fixture.socketPath,
      "desktop.create-organization",
      { name: "Confuse" },
    );
    expect(organization.ok).toBe(true);
    const allowed = await invoke(fixture.socketPath, "agents.connect", {
      selections: [{ kind: "kimi-code", importHistory: false }],
    });
    expect(allowed.ok).toBe(true);
    await fixture.supervisor.jobs.drain();
    expect(
      fixture.supervisor.store.getJob(allowed.result.jobIds[0]).job.state,
    ).toBe("succeeded");
  });

  it("removes only Confuse-managed integrations from all Agent homes", async () => {
    const fixture = await createFixture({
      isCodexHookTrusted: async () => true,
    });
    await Promise.all([
      installFakeKimi(fixture.bin),
      installFakeClaude(fixture.bin),
      installFakeDsh(fixture.bin),
      installFakeCodex(fixture.applications),
    ]);
    await Promise.all([
      mkdir(join(fixture.home, ".kimi-code"), { recursive: true }),
      mkdir(join(fixture.home, ".claude"), { recursive: true }),
      mkdir(join(fixture.home, ".codex"), { recursive: true }),
      mkdir(join(fixture.home, ".dsh"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(fixture.home, ".kimi-code", "config.toml"),
        'default_model = "user-model"\n',
      ),
      writeFile(
        join(fixture.home, ".claude", "settings.json"),
        JSON.stringify({
          otherSetting: true,
          hooks: {
            Stop: [
              {
                matcher: "user",
                hooks: [{ type: "command", command: "user-command" }],
              },
            ],
          },
        }),
      ),
      writeFile(
        join(fixture.home, ".codex", "hooks.json"),
        JSON.stringify({
          description: "mine",
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "user-command" }] }],
          },
        }),
      ),
      writeFile(
        join(fixture.home, ".dsh", "cordis.patch.yml"),
        "plugins:\n  - path: user-plugin\n",
      ),
    ]);
    await fixture.supervisor.start({ runtime: false });
    const connected = await invoke(fixture.socketPath, "agents.connect", {
      selections: [
        { kind: "kimi-code", importHistory: false },
        { kind: "chatgpt-codex", importHistory: false },
        { kind: "claude-code", importHistory: false },
        { kind: "deepseek-harness", importHistory: false },
      ],
    });
    expect(connected.ok).toBe(true);
    await fixture.supervisor.jobs.drain();
    for (const jobId of connected.result.jobIds) {
      expect(fixture.supervisor.store.getJob(jobId).job.state).toBe(
        "succeeded",
      );
    }
    fixture.supervisor.store.saveAgentProject({
      kind: "kimi-code",
      id: "confuse-kimi-code",
      name: "Kimi Code",
    });

    const removed = await invoke(
      fixture.socketPath,
      "desktop.remove-integrations",
      undefined,
    );
    expect(removed.ok).toBe(true);
    expect(removed.result.state).toBe("succeeded");
    expect(removed.result.message).toContain("history are preserved");

    const [kimi, claude, codex, dsh] = await Promise.all([
      readFile(join(fixture.home, ".kimi-code", "config.toml"), "utf8"),
      readFile(join(fixture.home, ".claude", "settings.json"), "utf8"),
      readFile(join(fixture.home, ".codex", "hooks.json"), "utf8"),
      readFile(join(fixture.home, ".dsh", "cordis.patch.yml"), "utf8"),
    ]);
    expect(kimi).toContain("user-model");
    expect(kimi).not.toContain("confuse-agent-connector");
    expect(claude).toContain("otherSetting");
    expect(claude).toContain("user-command");
    expect(claude).not.toContain("confuse-forward.mjs");
    expect(codex).toContain("mine");
    expect(codex).toContain("user-command");
    expect(codex).not.toContain("confuse-forward.mjs");
    expect(dsh).toContain("user-plugin");
    expect(dsh).not.toContain("confuse-plugin");
    for (const script of [
      join(fixture.home, ".kimi-code", "hooks", "confuse-forward.mjs"),
      join(fixture.home, ".claude", "hooks", "confuse-forward.mjs"),
      join(fixture.home, ".codex", "hooks", "confuse-forward.mjs"),
      join(fixture.home, ".dsh", "confuse-plugin", "index.js"),
    ]) {
      await expect(stat(script)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(fixture.supervisor.store.getOrganization()).toBeUndefined();
    expect(
      fixture.supervisor.store.getAgentConnection("kimi-code"),
    ).toBeUndefined();
    expect(
      fixture.supervisor.store.getAgentProject("kimi-code"),
    ).toBeUndefined();
  });
});

describe("SdkOutboxDispatcher", () => {
  it("isolates Agent project clients and the legacy default project", async () => {
    const options: NodeLangfuseV6Options[] = [];
    const clients: FakeClient[] = [];
    const projects: AgentProjects = {
      ensureOrganization: async () => ({
        id: "confuse-desktop",
        name: "Confuse",
      }),
      revoke: async () => undefined,
      ensure: async (kind) => ({
        kind,
        id: `confuse-${kind}`,
        name: kind,
      }),
      clientOptions: async (kind, projectId) => ({
        baseUrl: "http://127.0.0.1:3000",
        publicKey: projectId ? `pk-lf-${kind}` : "pk-lf-default",
        secretKey: projectId ? `sk-lf-${kind}` : "sk-lf-default",
      }),
    };
    const dispatcher = new SdkOutboxDispatcher(projects, (received) => {
      options.push(received);
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
    const kimi = telemetryEvent();
    kimi.metadata = { projectId: "confuse-kimi-code" };
    const claude = {
      ...telemetryEvent(),
      id: "claude-event",
      agent: "claude-code" as const,
      metadata: { projectId: "confuse-claude-code" },
    };
    const legacy = { ...telemetryEvent(), id: "legacy-event" };
    for (const event of [kimi, claude, legacy]) {
      await dispatcher.dispatch({
        id: event.id,
        kind: "telemetry",
        payload: event,
        attempts: 0,
        nextAttemptAt: event.timestamp!,
        createdAt: event.timestamp!,
      });
    }

    expect(options.map((option) => option.publicKey)).toEqual([
      "pk-lf-kimi-code",
      "pk-lf-claude-code",
      "pk-lf-default",
    ]);
    expect(options.map((option) => option.environment)).toEqual([
      "confuse-desktop",
      "confuse-desktop",
      "confuse-desktop",
    ]);
    expect(clients.map((client) => client.flushes)).toEqual([1, 1, 1]);
    await dispatcher.close();
    expect(clients.map((client) => client.shutdowns)).toEqual([1, 1, 1]);
  });
});

async function createFixture(
  options: {
    isCodexHookTrusted?: (command: string) => Promise<boolean>;
    waitingCodexJobPollMs?: number;
  } = {},
) {
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
  const projects: AgentProjects = {
    ensureOrganization: async () => {
      const organization = { id: "confuse-desktop", name: "Confuse" };
      supervisor.store.saveOrganization(organization);
      return organization;
    },
    revoke: async () => undefined,
    ensure: async (kind) => ({
      kind,
      id: `confuse-${kind}`,
      name: kind,
    }),
    clientOptions: async (kind, projectId) => ({
      baseUrl: "http://127.0.0.1:3000",
      publicKey: projectId ? `pk-lf-${kind}` : "pk-lf-default",
      secretKey: projectId ? `sk-lf-${kind}` : "sk-lf-default",
    }),
  };
  const supervisor = new Supervisor(
    readSupervisorConfig({
      CONFUSE_STATE_DIR: stateDir,
      CONFUSE_OUTBOX_POLL_MS: "100000",
    }),
    {
      secrets: new MemorySecretStore(),
      projects,
      agentContext: {
        homeDir: home,
        env: { HOME: home, PATH: bin },
        applicationDirs: [applications],
        ...(options.isCodexHookTrusted === undefined
          ? {}
          : { isCodexHookTrusted: options.isCodexHookTrusted }),
      },
      waitingCodexJobPollMs: options.waitingCodexJobPollMs,
    },
  );
  supervisor.store.saveOrganization({ id: "confuse-desktop", name: "Confuse" });
  supervisors.push(supervisor);
  return {
    supervisor,
    socketPath,
    bin,
    root,
    home,
    applications,
    historyFile: join(historyDirectory, "wire.jsonl"),
  };
}

async function installFakeCodex(applications: string): Promise<void> {
  const contents = join(applications, "ChatGPT.app", "Contents");
  await mkdir(contents, { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>com.openai.codex</string>\n<key>CFBundleShortVersionString</key><string>1.0.0</string>\n</dict></plist>\n`,
  );
}

async function installFakeKimi(bin: string): Promise<void> {
  const executable = join(bin, "kimi");
  await writeFile(executable, "#!/bin/sh\necho 'kimi 1.2.3'\n");
  await chmod(executable, 0o755);
}

async function installFakeClaude(bin: string): Promise<void> {
  const executable = join(bin, "claude");
  await writeFile(executable, "#!/bin/sh\necho 'claude 1.2.3'\n");
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

function codexHookEnvelope(eventId: string) {
  return {
    source: "confuse-agent-hook",
    agent: "chatgpt-codex",
    payload: {
      hook_event_name: "SessionStart",
      session_id: "synthetic-live-thread",
      event_id: eventId,
    },
  };
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
