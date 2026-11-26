import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPOSE_SERVICES, ComposeManager } from "./compose";
import { readSupervisorConfig } from "./config";
import { HealthChecker } from "./health";
import {
  loadOrCreateSecrets,
  MacOsKeychain,
  MemorySecretStore,
} from "./keychain";
import { LaunchAgentManager } from "./launch-agent";
import {
  ProcessRunError,
  type ProcessRunner,
  type ProcessRunOptions,
} from "./process";

class MockRunner implements ProcessRunner {
  readonly calls: {
    command: string;
    args: string[];
    options?: ProcessRunOptions;
  }[] = [];
  keychain?: string;
  launchAgentLoaded = false;
  launchAgentError?: ProcessRunError;

  async run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ) {
    this.calls.push({ command, args: [...args], options });
    if (
      command === "/bin/launchctl" &&
      args[0] === "print" &&
      !this.launchAgentLoaded
    ) {
      throw (
        this.launchAgentError ??
        new ProcessRunError("Could not find service", 113, null)
      );
    }
    if (command === "/bin/launchctl" && args[0] === "bootstrap")
      this.launchAgentLoaded = true;
    if (command === "/bin/launchctl" && args[0] === "bootout")
      this.launchAgentLoaded = false;
    if (command === "/usr/bin/security" && args[0] === "-i") {
      this.keychain = options?.input?.match(/-w ([A-Za-z0-9+/=]+)/)?.[1];
      return { stdout: "", stderr: "" };
    }
    if (
      command === "/usr/bin/security" &&
      args[0] === "find-generic-password"
    ) {
      if (!this.keychain) throw new ProcessRunError("Not found", 44, null);
      return { stdout: `${this.keychain}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

describe("system adapters", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function config(stateDir: string) {
    return readSupervisorConfig({
      CONFUSE_STATE_DIR: stateDir,
      CONFUSE_RESOURCE_DIR: resolve("resources"),
    });
  }

  it("uses fixed Compose arguments and passes secrets only through the child environment", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-compose-"));
    directories.push(stateDir);
    const runner = new MockRunner();
    const manager = new ComposeManager(
      config(stateDir),
      new MemorySecretStore(),
      runner,
      { PATH: "/usr/bin" },
    );
    await manager.start();
    await manager.stop();
    const start = runner.calls[0];
    expect(start.args.slice(0, 3)).toEqual([
      "compose",
      "--project-name",
      "confuse",
    ]);
    expect(start.args.slice(-6)).toEqual([...COMPOSE_SERVICES]);
    expect(start.options?.env?.POSTGRES_PASSWORD).toBeDefined();
    expect(start.options?.env?.CONFUSE_WEB_IMAGE).toBe(
      "ghcr.io/ulinwang/confuse-web:0.1.0",
    );
    expect(start.options?.env?.CONFUSE_WORKER_IMAGE).toBe(
      "ghcr.io/ulinwang/confuse-worker:0.1.0",
    );
    expect(JSON.stringify(start.args)).not.toContain(
      start.options?.env?.POSTGRES_PASSWORD,
    );
    const stop = runner.calls[1];
    expect(stop.args).toContain("down");
    expect(stop.args).not.toContain("-v");
    expect(stop.args).not.toContain("--volumes");
  });

  it("prefers the Docker Desktop CLI and allows ten minutes for the initial image pull", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-docker-desktop-"));
    directories.push(stateDir);
    const home = join(stateDir, "home");
    const dockerBin = join(home, ".docker", "bin");
    mkdirSync(dockerBin, { recursive: true });
    const dockerPath = join(dockerBin, "docker");
    writeFileSync(dockerPath, "#!/bin/sh\n");
    chmodSync(dockerPath, 0o755);
    const runner = new MockRunner();
    const manager = new ComposeManager(
      readSupervisorConfig({
        CONFUSE_STATE_DIR: stateDir,
        CONFUSE_RESOURCE_DIR: resolve("resources"),
        HOME: home,
      }),
      new MemorySecretStore(),
      runner,
      { HOME: home, PATH: "/usr/bin" },
    );

    await manager.start();

    const start = runner.calls[0];
    expect(start.command).toBe(dockerPath);
    expect(start.args).toContain("600");
    expect(start.options?.timeoutMs).toBe(630_000);
  });

  it("accepts only the Confuse health identity from the desktop health endpoint", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-health-"));
    directories.push(stateDir);
    const requests: string[] = [];
    const responses = [
      { status: "ok", service: "langfuse" },
      { status: "ok", service: "confuse" },
    ];
    const checker = new HealthChecker(
      config(stateDir),
      new MockRunner(),
      async (input) => {
        requests.push(String(input));
        return Response.json(responses.shift());
      },
    );

    expect(await checker.webIsReady()).toBe(false);
    expect(await checker.webIsReady()).toBe(true);
    expect(requests).toEqual([
      "http://127.0.0.1:3000/api/desktop/health",
      "http://127.0.0.1:3000/api/desktop/health",
    ]);
  });

  it("verifies synthetic ingestion through the OTel endpoint", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-otel-health-"));
    directories.push(stateDir);
    const requests: { url: string; body: any }[] = [];
    const checker = new HealthChecker(
      config(stateDir),
      new MockRunner(),
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({});
      },
    );

    await checker.verifyIngestion(
      await loadOrCreateSecrets(new MemorySecretStore()),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://127.0.0.1:3000/api/public/otel/v1/traces",
    );
    const span = requests[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toMatchObject({ name: "Confuse startup check", kind: 1 });
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("keeps Keychain values out of process arguments", async () => {
    const runner = new MockRunner();
    const keychain = new MacOsKeychain(runner);
    await keychain.set("SALT", "synthetic-secret");
    expect(runner.calls[0].args).toEqual(["-i"]);
    expect(runner.calls[0].options?.input).not.toContain("synthetic-secret");
    expect(await keychain.get("SALT")).toBe("synthetic-secret");
  });

  it("does not treat launchctl failures as an unloaded LaunchAgent", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-launch-agent-error-"));
    directories.push(stateDir);
    const runner = new MockRunner();
    runner.launchAgentError = new ProcessRunError(
      "launchctl print failed: Input/output error",
      5,
      null,
    );
    const manager = new LaunchAgentManager(
      config(stateDir),
      runner,
      process.getuid(),
      join(stateDir, "com.confuse.supervisor.plist"),
      "darwin",
    );

    await expect(manager.uninstall()).rejects.toThrow("Input/output error");
  });

  it("installs and uninstalls a LaunchAgent only in the requested temporary path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "confuse-launch-agent-"));
    directories.push(stateDir);
    const supervisorEntry = join(stateDir, "index.mjs");
    writeFileSync(supervisorEntry, "");
    const plistPath = join(
      stateDir,
      "LaunchAgents",
      "com.confuse.supervisor.plist",
    );
    const runner = new MockRunner();
    const manager = new LaunchAgentManager(
      {
        ...readSupervisorConfig({
          CONFUSE_STATE_DIR: stateDir,
          CONFUSE_RESOURCE_DIR: resolve("resources"),
          CONFUSE_WEB_IMAGE: "confuse-web:local",
          CONFUSE_WORKER_IMAGE: "confuse-worker:local",
          CONFUSE_WEB_PORT: "3123",
          CONFUSE_MINIO_PORT: "9123",
          CONFUSE_MINIO_CONSOLE_PORT: "9124",
          POSTGRES_PASSWORD: "must-not-be-forwarded",
          CONFUSE_DESKTOP_AUTH_TOKEN: "must-not-be-forwarded",
        }),
        supervisorEntryPath: supervisorEntry,
      },
      runner,
      process.getuid(),
      plistPath,
      "darwin",
    );
    await manager.install();
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain(resolve(supervisorEntry));
    expect(plist).toContain(
      "<key>CONFUSE_WEB_IMAGE</key>\n    <string>confuse-web:local</string>",
    );
    expect(plist).toContain(
      "<key>CONFUSE_WORKER_IMAGE</key>\n    <string>confuse-worker:local</string>",
    );
    expect(plist).toContain(
      "<key>CONFUSE_WEB_PORT</key>\n    <string>3123</string>",
    );
    expect(plist).toContain(
      "<key>CONFUSE_MINIO_PORT</key>\n    <string>9123</string>",
    );
    expect(plist).toContain(
      "<key>CONFUSE_MINIO_CONSOLE_PORT</key>\n    <string>9124</string>",
    );
    expect(plist).toContain(
      `<key>CONFUSE_RESOURCE_DIR</key>\n    <string>${resolve("resources")}</string>`,
    );
    expect(plist).not.toContain("POSTGRES_PASSWORD");
    expect(plist).not.toContain("must-not-be-forwarded");
    expect(runner.calls.some((call) => call.args[0] === "bootstrap")).toBe(
      true,
    );
    await manager.uninstall();
    const bootout = runner.calls.find((call) => call.args[0] === "bootout");
    expect(bootout?.args[1]).toBe(
      `gui/${process.getuid()}/com.confuse.supervisor`,
    );
    expect(bootout?.args[1]).not.toBe(`gui/${process.getuid()}`);
  });
});
