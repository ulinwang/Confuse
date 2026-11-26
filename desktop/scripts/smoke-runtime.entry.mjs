import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSupervisorConfig } from "../src/supervisor/config";
import {
  loadOrCreateSecrets,
  MemorySecretStore,
} from "../src/supervisor/keychain";
import { AgentProjectRegistry } from "../src/supervisor/agent-projects";
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
const composeProject = `confuse-smoke-${randomUUID().replaceAll("-", "")}`;
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
    timestamp: new Date().toISOString(),
  })}\n`,
);
const fakeKimi = join(bin, "kimi");
await writeFile(fakeKimi, "#!/bin/sh\necho 'kimi 1.2.3'\n");
await chmod(fakeKimi, 0o755);
const fakeClaude = join(bin, "claude");
await writeFile(fakeClaude, "#!/bin/sh\necho 'claude 1.2.3'\n");
await chmod(fakeClaude, 0o755);

const baseConfig = readSupervisorConfig({
  ...process.env,
  CONFUSE_STATE_DIR: stateDir,
  CONFUSE_WEB_PORT: "39000",
  CONFUSE_MINIO_PORT: "39090",
  CONFUSE_MINIO_CONSOLE_PORT: "39091",
  CONFUSE_STARTUP_TIMEOUT_MS: "600000",
  CONFUSE_OUTBOX_POLL_MS: "250",
});
const releaseVersion = process.env.CONFUSE_RELEASE_VERSION;
assert.ok(releaseVersion, "CONFUSE_RELEASE_VERSION is required");
assert.equal(
  baseConfig.webImage,
  `ghcr.io/ulinwang/confuse-web:${releaseVersion}`,
);
assert.equal(
  baseConfig.workerImage,
  `ghcr.io/ulinwang/confuse-worker:${releaseVersion}`,
);
const baseCompose = await readFile(baseConfig.composeFile, "utf8");
const publishedWebPort = " - 127.0.0.1:${CONFUSE_WEB_PORT:-3000}:3000";
assert.ok(baseCompose.includes(publishedWebPort));
const config = {
  ...baseConfig,
  composeFile: join(root, "compose-session.yml"),
  composeProject,
};
await writeFile(
  config.composeFile,
  baseCompose.replace(
    publishedWebPort,
    `${publishedWebPort}\n      - "127.0.0.1:39001:39001"`,
  ),
);
const secrets = new MemorySecretStore();
const desktopSessionWebUrl = "http://127.0.0.1:39001";
const desktopFetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok && String(input).includes("/api/desktop/")) {
    const body = await response.clone().text();
    console.error(
      await redact(
        `Desktop API returned HTTP ${response.status}: ${body.slice(0, 1000)}`,
      ),
    );
  }
  return response;
};
const supervisor = new Supervisor(config, {
  secrets,
  projects: (store) =>
    new AgentProjectRegistry({
      secrets,
      store,
      baseUrl: desktopSessionWebUrl,
      fetch: desktopFetch,
    }),
  fetch: desktopFetch,
  agentContext: {
    homeDir: home,
    env: { HOME: home, PATH: bin },
    applicationDirs: [join(home, "Applications")],
  },
});
const verifyIngestion = supervisor.health.verifyIngestion.bind(
  supervisor.health,
);
let startupProbeSucceeded = false;
supervisor.health.verifyIngestion = async (secrets) => {
  await verifyIngestion(secrets);
  startupProbeSucceeded = true;
};

async function invoke(channel, payload, timeoutMs = 15000) {
  const socket = createConnection(config.socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  socket.setTimeout(timeoutMs, () => {
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
  assert.equal(result.ok, true, JSON.stringify(result.error));
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

async function smokeVolumes() {
  return dockerLines([
    "volume",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--format",
    "{{.Name}}",
  ]);
}

async function removeSmokeVolumes() {
  const volumes = await smokeVolumes();
  if (volumes.length > 0) {
    await execFileAsync("/usr/bin/docker", ["volume", "rm", ...volumes], {
      timeout: 15000,
    });
  }
}

async function redact(text) {
  const values = Object.values(await loadOrCreateSecrets(secrets));
  return values.reduce(
    (output, value) => output.replaceAll(value, "[redacted]"),
    text,
  );
}

function desktopSessionUrl(path) {
  const url = new URL(path, desktopSessionWebUrl);
  assert.equal(url.origin, desktopSessionWebUrl);
  assert.equal(url.hostname, "127.0.0.1");
  return url;
}

let sessionProxyContainer;
let sessionProxyPid;

async function startDesktopSessionProxy() {
  [sessionProxyContainer] = await dockerLines([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--filter",
    "label=com.docker.compose.service=langfuse-web",
    "--format",
    "{{.Names}}",
  ]);
  assert.ok(sessionProxyContainer);
  const script =
    'const net = require("net"); net.createServer((client) => { const upstream = net.connect({ host: "127.0.0.1", port: 3000 }); client.pipe(upstream); upstream.pipe(client); client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy()); }).listen(39001, "0.0.0.0");';
  const { stdout } = await execFileAsync("/usr/bin/docker", [
    "exec",
    sessionProxyContainer,
    "bash",
    "-c",
    `node -e '${script}' > /tmp/confuse-smoke-session-proxy.log 2>&1 & echo $!`,
  ]);
  sessionProxyPid = stdout.trim();
  assert.match(sessionProxyPid, /^\d+$/);
  await waitFor(
    async () => {
      const response = await fetch(desktopSessionUrl("/api/desktop/health"), {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    },
    15000,
    "the loopback session proxy",
  );
}

async function stopDesktopSessionProxy() {
  if (!sessionProxyContainer || !sessionProxyPid) return;
  await execFileAsync("/usr/bin/docker", [
    "exec",
    sessionProxyContainer,
    "bash",
    "-c",
    `kill ${sessionProxyPid}`,
  ]).catch((error) => {
    if (!/No such process|No such container|not running/.test(String(error))) {
      throw error;
    }
  });
  sessionProxyPid = undefined;
}

let sessionCookie;
let observedTrace;
async function desktopSessionCookie() {
  if (sessionCookie) return sessionCookie;
  const token = await secrets.get("CONFUSE_DESKTOP_AUTH_TOKEN");
  assert.ok(token);
  const response = await fetch(desktopSessionUrl("/api/desktop/session"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: new URL(desktopSessionWebUrl).host,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 204) {
    const body = (await response.text()).slice(0, 2000);
    throw new Error(
      await redact(
        `Desktop session exchange returned HTTP ${response.status}: ${body}`,
      ),
    );
  }
  sessionCookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sessionCookie, "Desktop session did not return a cookie");
  return sessionCookie;
}

async function desktopTrace(traceId, projectId = "confuse-local") {
  const input = encodeURIComponent(
    JSON.stringify({ json: { traceId, projectId } }),
  );
  const response = await fetch(
    desktopSessionUrl(`/api/trpc/traces.byId?input=${input}`),
    {
      headers: { cookie: await desktopSessionCookie() },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2000);
    throw new Error(
      await redact(`Trace query returned HTTP ${response.status}: ${body}`),
    );
  }
  const body = await response.json();
  const trace = body.result?.data?.json;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    throw new Error("Trace response is missing result.data.json");
  }
  return trace;
}

async function reportFailure(error) {
  try {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(await redact(`Smoke failure: ${message}`));
    const jobs = supervisor.store.listJobs().map((job) => ({
      kind: job.kind,
      state: job.state,
      message: job.message,
    }));
    console.error(await redact(`Smoke jobs: ${JSON.stringify(jobs)}`));
    const outbox = supervisor.store
      .dueOutbox("9999-01-01T00:00:00.000Z")
      .map((record) => ({
        id: record.id,
        attempts: record.attempts,
        agent: record.payload.agent,
        name: record.payload.name,
        traceId: record.payload.traceId,
      }));
    console.error(await redact(`Smoke outbox: ${JSON.stringify(outbox)}`));
    if (observedTrace) {
      console.error(
        await redact(`Observed trace: ${JSON.stringify(observedTrace)}`),
      );
    }
    if (sessionProxyContainer) {
      const logs = await execFileAsync("/usr/bin/docker", [
        "exec",
        sessionProxyContainer,
        "bash",
        "-c",
        "cat /tmp/confuse-smoke-session-proxy.log",
      ]).catch(() => undefined);
      if (logs) {
        const output = `${logs.stdout}\n${logs.stderr}`.slice(-10000);
        console.error(await redact(`Session proxy logs:\n${output}`));
      }
    }
    for (const service of ["langfuse-web", "langfuse-worker"]) {
      const names = await dockerLines([
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${composeProject}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
        "--format",
        "{{.Names}}",
      ]);
      for (const name of names) {
        const logs = await execFileAsync(
          "/usr/bin/docker",
          ["logs", "--tail", "120", name],
          { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
        );
        const output = `${logs.stdout}\n${logs.stderr}`.slice(-20000);
        console.error(await redact(`${service} recent logs:\n${output}`));
      }
    }
  } catch (diagnosticError) {
    const message =
      diagnosticError instanceof Error
        ? diagnosticError.message
        : String(diagnosticError);
    console.error(
      await redact(`Could not collect all smoke diagnostics: ${message}`),
    );
  }
}

async function cleanupSmokeResources() {
  let firstError;
  for (const cleanup of [
    () => supervisor.stop(true),
    stopDesktopSessionProxy,
    removeSmokeVolumes,
    () => rm(root, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

let failure;
let cleanupError;
try {
  await supervisor.start();
  await waitFor(
    async () => (await invoke("desktop.get-state")).runtime === "ready",
    600000,
    "the six-service runtime",
  );
  assert.equal(
    startupProbeSucceeded,
    true,
    "The startup OTLP probe did not succeed",
  );
  const containers = await dockerLines([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--format",
    "{{.Names}}",
  ]);
  assert.equal(containers.length, 6, containers.join(", "));
  await startDesktopSessionProxy();

  const agents = await invoke("agents.scan");
  assert.equal(
    agents.find((agent) => agent.kind === "kimi-code")?.installed,
    true,
  );
  assert.equal(
    agents.find((agent) => agent.kind === "claude-code")?.installed,
    true,
  );
  const organization = await invoke("desktop.create-organization", {
    name: "Confuse Smoke",
  });
  assert.equal(organization.id, "confuse-desktop");
  assert.equal(organization.name, "Confuse Smoke");
  const previews = await invoke("history.preview", { kinds: ["kimi-code"] });
  assert.equal(previews[0]?.sessionCount, 1);
  assert.equal(
    supervisor.store.dueOutbox("9999-01-01T00:00:00.000Z").length,
    0,
  );

  const connected = await invoke("desktop.complete-onboarding", {
    selections: [
      { kind: "kimi-code", importHistory: true },
      { kind: "claude-code", importHistory: false },
    ],
  });
  await supervisor.jobs.drain();
  for (const jobId of connected.jobIds) {
    assert.equal(supervisor.store.getJob(jobId).job.state, "succeeded");
  }
  const connectedAgents = await invoke("agents.scan");
  assert.equal(
    connectedAgents.find((agent) => agent.kind === "kimi-code")?.project?.id,
    "confuse-kimi-code",
  );
  assert.equal(
    connectedAgents.find((agent) => agent.kind === "claude-code")?.project?.id,
    "confuse-claude-code",
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
  assert.ok(
    notifications.some(
      (notification) =>
        notification.actionRoute === "/project/confuse-kimi-code/sessions",
    ),
  );
  assert.ok(
    notifications.some(
      (notification) =>
        notification.actionRoute === "/project/confuse-claude-code/sessions",
    ),
  );
  const historyTraceId = createHash("sha256")
    .update(`kimi-code:${historySession}`)
    .digest("hex")
    .slice(0, 32);
  await waitFor(
    async () => {
      const trace = await desktopTrace(historyTraceId, "confuse-kimi-code");
      if (
        trace.id === historyTraceId &&
        trace.name === "kimi-code session" &&
        trace.sessionId === historySession
      ) {
        return true;
      }
      observedTrace = {
        id: trace.id,
        name: trace.name,
        sessionId: trace.sessionId,
        projectId: trace.projectId,
        metadata: trace.metadata,
      };
      return false;
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
      const trace = await desktopTrace(liveTraceId, "confuse-kimi-code");
      if (trace.id === liveTraceId && trace.sessionId === liveSession) {
        return true;
      }
      observedTrace = {
        id: trace.id,
        name: trace.name,
        sessionId: trace.sessionId,
        projectId: trace.projectId,
        metadata: trace.metadata,
      };
      return false;
    },
    120000,
    "live Agent telemetry in Langfuse",
  );
  await waitFor(
    () => supervisor.store.dueOutbox("9999-01-01T00:00:00.000Z").length === 0,
    120000,
    "the telemetry outbox to drain",
  );

  const removed = await invoke("desktop.remove-integrations", undefined);
  assert.equal(removed.state, "succeeded");
  const cleanedAgents = await invoke("agents.scan");
  for (const kind of ["kimi-code", "claude-code"]) {
    const agent = cleanedAgents.find((candidate) => candidate.kind === kind);
    assert.equal(agent?.connectionState, "not-connected");
    assert.equal(agent?.project, undefined);
  }
  assert.equal(supervisor.store.getOrganization(), undefined);
  assert.equal(supervisor.store.getAgentProject("kimi-code"), undefined);
  const scriptErrors = await Promise.all(
    [
      join(home, ".kimi-code", "hooks", "confuse-forward.mjs"),
      join(home, ".claude", "hooks", "confuse-forward.mjs"),
    ].map((path) => stat(path).catch((error) => error)),
  );
  assert.ok(scriptErrors.every((error) => error.code === "ENOENT"));
  const retainedTrace = await desktopTrace(historyTraceId, "confuse-kimi-code");
  assert.equal(retainedTrace.id, historyTraceId);
  assert.equal(retainedTrace.sessionId, historySession);
  assert.ok(
    (await invoke("notifications.list")).some(
      (notification) => notification.title === "Confuse integrations removed",
    ),
  );

  await stopDesktopSessionProxy();
  await invoke("desktop.quit", undefined, 90000);
  assert.deepEqual(
    await dockerLines([
      "ps",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.Names}}",
    ]),
    [],
  );
  assert.equal((await smokeVolumes()).length, 5);
  console.log(
    "Confuse runtime smoke passed: six services, organization and per-Agent projects, opt-in history, live SDK ingestion, notification, safe cleanup, clean quit, and preserved volumes.",
  );
} catch (error) {
  failure = error;
  await reportFailure(error);
} finally {
  cleanupError = await cleanupSmokeResources();
}
if (cleanupError) {
  if (failure === undefined) throw cleanupError;
  const message =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  console.error(await redact(`Smoke cleanup failed: ${message}`));
}
if (failure !== undefined) throw failure;
