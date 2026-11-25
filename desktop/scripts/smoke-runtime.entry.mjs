import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSupervisorConfig } from "../src/supervisor/config";
import { MemorySecretStore } from "../src/supervisor/keychain";
import { Supervisor } from "../src/supervisor/supervisor";

const execFileAsync = promisify(execFile);
assert.equal(process.env.CI, "true");
assert.equal(process.env.CONFUSE_SMOKE_ISOLATED, "1");

const root = await mkdtemp(join(tmpdir(), "confuse-data-plane-"));
const stateDir = join(root, "state");
const home = join(root, "home");
const bin = join(root, "bin");
const historySession = `synthetic-history-${randomUUID()}`;
const liveSession = `synthetic-live-${randomUUID()}`;
const historyDirectory = join(home, ".kimi-code", "sessions", historySession);
await Promise.all([
  mkdir(bin, { recursive: true }),
  mkdir(join(home, "Applications"), { recursive: true }),
  mkdir(historyDirectory, { recursive: true }),
]);
await writeFile(
  join(historyDirectory, "wire.jsonl"),
  `${JSON.stringify({
    type: "assistant",
    session_id: historySession,
    event_id: "synthetic-history-event",
    timestamp: "2026-01-01T00:00:00.000Z",
  })}\n`,
);
const fakeKimi = join(bin, "kimi");
await writeFile(fakeKimi, "#!/bin/sh\necho 'kimi 1.2.3'\n");
await chmod(fakeKimi, 0o755);

const config = readSupervisorConfig({
  ...process.env,
  CONFUSE_STATE_DIR: stateDir,
  CONFUSE_WEB_PORT: "39000",
  CONFUSE_MINIO_PORT: "39090",
  CONFUSE_MINIO_CONSOLE_PORT: "39091",
  CONFUSE_STARTUP_TIMEOUT_MS: "600000",
  CONFUSE_OUTBOX_POLL_MS: "250",
});
const secrets = new MemorySecretStore();
const supervisor = new Supervisor(config, {
  secrets,
  agentContext: {
    homeDir: home,
    env: { HOME: home, PATH: bin },
    applicationDirs: [join(home, "Applications")],
  },
});

async function invoke(channel, payload) {
  const socket = createConnection(config.socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  socket.setTimeout(15000, () => {
    socket.destroy(new Error(`Socket request timed out: ${channel}`));
  });
  const id = randomUUID();
  const response = new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
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
  const result = await response;
  assert.equal(result.ok, true, result.error?.message);
  return result.result;
}

async function postHook(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath: config.socketPath,
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
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        });
      },
    );
    call.setTimeout(15000, () => call.destroy(new Error("Hook timed out")));
    call.once("error", reject);
    call.end(body);
  });
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function dockerLines(args) {
  const { stdout } = await execFileAsync("/usr/bin/docker", args, {
    timeout: 15000,
  });
  return stdout.split("\n").filter(Boolean);
}

async function credentials() {
  const publicKey = await secrets.get("LANGFUSE_INIT_PROJECT_PUBLIC_KEY");
  const secretKey = await secrets.get("LANGFUSE_INIT_PROJECT_SECRET_KEY");
  assert.ok(publicKey && secretKey);
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

async function publicJson(path) {
  const response = await fetch(`${config.webUrl}${path}`, {
    headers: { authorization: await credentials() },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.ok, true, `Web API returned HTTP ${response.status}`);
  return response.json();
}

try {
  await supervisor.start();
  await waitFor(
    async () => (await invoke("desktop.get-state")).runtime === "ready",
    600000,
    "the six-service runtime",
  );
  const containers = await dockerLines([
    "ps",
    "--filter",
    "label=com.docker.compose.project=confuse",
    "--format",
    "{{.Names}}",
  ]);
  assert.equal(containers.length, 6, containers.join(", "));

  const agents = await invoke("agents.scan");
  assert.equal(
    agents.find((agent) => agent.kind === "kimi-code")?.installed,
    true,
  );
  const previews = await invoke("history.preview", { kinds: ["kimi-code"] });
  assert.equal(previews[0]?.sessionCount, 1);
  assert.equal(
    supervisor.store.dueOutbox("9999-01-01T00:00:00.000Z").length,
    0,
  );

  const connected = await invoke("desktop.complete-onboarding", {
    selections: [{ kind: "kimi-code", importHistory: true }],
  });
  await supervisor.jobs.drain();
  assert.equal(
    supervisor.store.getJob(connected.jobIds[0]).job.state,
    "succeeded",
  );
  const notifications = await invoke("notifications.list");
  assert.ok(
    notifications.some(
      (notification) =>
        notification.title === "Agent connection completed" &&
        notification.severity === "success" &&
        notification.body.includes("Scanned 1 record(s); queued 1"),
    ),
  );
  await waitFor(
    async () => {
      const traces = await publicJson(
        `/api/public/traces?sessionId=${encodeURIComponent(historySession)}`,
      );
      return traces.data?.some((trace) => trace.name === "kimi-code:assistant");
    },
    120000,
    "historical Agent telemetry in Langfuse",
  );

  const envelope = {
    source: "confuse-agent-hook",
    agent: "kimi-code",
    sentAt: new Date().toISOString(),
    payload: {
      hook_event_name: "Stop",
      session_id: liveSession,
      turn_id: "turn-1",
      event_id: "event-1",
      model: "synthetic-model",
      usage: { input_tokens: 3, output_tokens: 2 },
      last_assistant_message: "synthetic response",
    },
  };
  assert.deepEqual(await postHook(envelope), {
    status: 202,
    body: { accepted: 2 },
  });
  const liveTraceId = createHash("sha256")
    .update(JSON.stringify(["kimi-code", "session", undefined, liveSession]))
    .digest("hex")
    .slice(0, 32);
  await waitFor(
    async () => {
      const trace = await publicJson(`/api/public/traces/${liveTraceId}`);
      return trace.id === liveTraceId && trace.sessionId === liveSession;
    },
    120000,
    "live Agent telemetry in Langfuse",
  );
  assert.equal(
    supervisor.store.dueOutbox("9999-01-01T00:00:00.000Z").length,
    0,
  );

  await invoke("desktop.quit");
  assert.deepEqual(
    await dockerLines([
      "ps",
      "--filter",
      "label=com.docker.compose.project=confuse",
      "--format",
      "{{.Names}}",
    ]),
    [],
  );
  assert.equal(
    (
      await dockerLines([
        "volume",
        "ls",
        "--filter",
        "label=com.docker.compose.project=confuse",
        "--format",
        "{{.Name}}",
      ])
    ).length,
    5,
  );
  console.log(
    "Confuse runtime smoke passed: six services, opt-in history, live SDK ingestion, notification, clean quit, and preserved volumes.",
  );
} finally {
  await supervisor.stop(true);
  await rm(root, { recursive: true, force: true });
}
