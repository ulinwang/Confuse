import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { escape } from "he";
import { ensurePrivateDirectory, type SupervisorConfig } from "./config";
import { ProcessRunError, type ProcessRunner } from "./process";

export const LAUNCH_AGENT_LABEL = "com.confuse.supervisor";

function xml(value: string): string {
  return escape(value);
}

export class LaunchAgentManager {
  readonly plistPath: string;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly runner: ProcessRunner,
    private readonly uid = process.getuid?.(),
    plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${LAUNCH_AGENT_LABEL}.plist`,
    ),
    private readonly platform = process.platform,
  ) {
    if (this.uid === undefined)
      throw new Error("LaunchAgent management requires macOS");
    this.plistPath = plistPath;
  }

  async install(): Promise<void> {
    if (this.platform !== "darwin")
      throw new Error("LaunchAgent management requires macOS");
    ensurePrivateDirectory(this.config.stateDir);
    const nodePath = resolve(process.execPath);
    const entryPath = resolve(this.config.supervisorEntryPath);
    if (
      !existsSync(nodePath) ||
      !existsSync(entryPath) ||
      !existsSync(this.config.composeFile)
    ) {
      throw new Error("Supervisor entry point or Compose resource is missing");
    }
    let plist = readFileSync(this.config.launchAgentTemplatePath, "utf8");
    const replacements = {
      NODE_PATH: nodePath,
      SUPERVISOR_ENTRY: entryPath,
      STATE_DIR: this.config.stateDir,
      COMPOSE_FILE: this.config.composeFile,
      STDOUT_PATH: join(this.config.stateDir, "supervisor.log"),
      STDERR_PATH: join(this.config.stateDir, "supervisor-error.log"),
    };
    for (const [key, value] of Object.entries(replacements)) {
      plist = plist.replaceAll(`{{${key}}}`, xml(value));
    }
    const environmentVariables = /<key>EnvironmentVariables<\/key>\s*<dict>/;
    if (!environmentVariables.test(plist))
      throw new Error("LaunchAgent template has no environment dictionary");
    const forwardedEnvironment = {
      ELECTRON_RUN_AS_NODE: "1",
      CONFUSE_WEB_IMAGE: this.config.webImage,
      CONFUSE_WORKER_IMAGE: this.config.workerImage,
      CONFUSE_WEB_PORT: String(this.config.webPort),
      CONFUSE_MINIO_PORT: String(this.config.minioPort),
      CONFUSE_MINIO_CONSOLE_PORT: String(this.config.minioConsolePort),
      CONFUSE_RESOURCE_DIR: this.config.resourceDir,
    };
    const forwardedXml = Object.entries(forwardedEnvironment)
      .map(
        ([key, value]) =>
          `    <key>${key}</key>\n    <string>${xml(value)}</string>`,
      )
      .join("\n");
    plist = plist.replace(
      environmentVariables,
      (environment) => `${environment}\n${forwardedXml}`,
    );
    if (plist.includes("{{"))
      throw new Error("LaunchAgent template has unresolved placeholders");
    mkdirSync(dirname(this.plistPath), { recursive: true, mode: 0o755 });
    const temporary = `${this.plistPath}.${process.pid}.tmp`;
    writeFileSync(temporary, plist, { mode: 0o600 });
    renameSync(temporary, this.plistPath);
    chmodSync(this.plistPath, 0o644);
    if (await this.loaded())
      await this.runner.run("/bin/launchctl", [
        "bootout",
        this.serviceDomain(),
      ]);
    await this.runner.run("/bin/launchctl", [
      "bootstrap",
      this.domain(),
      this.plistPath,
    ]);
  }

  async uninstall(): Promise<void> {
    if (this.platform !== "darwin")
      throw new Error("LaunchAgent management requires macOS");
    if (await this.loaded())
      await this.runner.run("/bin/launchctl", [
        "bootout",
        this.serviceDomain(),
      ]);
    try {
      unlinkSync(this.plistPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private domain(): string {
    return `gui/${this.uid}`;
  }

  private serviceDomain(): string {
    return `${this.domain()}/${LAUNCH_AGENT_LABEL}`;
  }

  private async loaded(): Promise<boolean> {
    try {
      await this.runner.run("/bin/launchctl", ["print", this.serviceDomain()]);
      return true;
    } catch (error) {
      if (error instanceof ProcessRunError && error.exitCode === 113)
        return false;
      throw error;
    }
  }
}
