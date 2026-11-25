import { resolveDockerExecutable, type SupervisorConfig } from "./config";
import { loadOrCreateSecrets } from "./keychain";
import type { DesktopSecrets, SecretStore } from "./keychain";
import type { ProcessRunner } from "./process";

export const COMPOSE_SERVICES = [
  "postgres",
  "clickhouse",
  "redis",
  "minio",
  "langfuse-worker",
  "langfuse-web",
] as const;

export class ComposeManager {
  constructor(
    private readonly config: SupervisorConfig,
    private readonly secrets: SecretStore,
    private readonly runner: ProcessRunner,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(signal?: AbortSignal): Promise<DesktopSecrets> {
    const secrets = await loadOrCreateSecrets(this.secrets);
    await this.runner.run(
      resolveDockerExecutable(this.baseEnv),
      [
        "compose",
        "--project-name",
        this.config.composeProject,
        "--file",
        this.config.composeFile,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        String(Math.ceil(this.config.startupTimeoutMs / 1_000)),
        ...COMPOSE_SERVICES,
      ],
      {
        env: this.composeEnvironment(secrets),
        signal,
        timeoutMs: this.config.startupTimeoutMs + 30_000,
      },
    );
    return secrets;
  }

  async hasRunningServices(): Promise<boolean> {
    const secrets = await loadOrCreateSecrets(this.secrets);
    const result = await this.runner.run(
      resolveDockerExecutable(this.baseEnv),
      [
        "compose",
        "--project-name",
        this.config.composeProject,
        "--file",
        this.config.composeFile,
        "ps",
        "--status",
        "running",
        "--services",
        ...COMPOSE_SERVICES,
      ],
      { env: this.composeEnvironment(secrets) },
    );
    return result.stdout.trim().length > 0;
  }

  async stop(signal?: AbortSignal): Promise<void> {
    const secrets = await loadOrCreateSecrets(this.secrets);
    await this.runner.run(
      resolveDockerExecutable(this.baseEnv),
      [
        "compose",
        "--project-name",
        this.config.composeProject,
        "--file",
        this.config.composeFile,
        "down",
        "--timeout",
        "30",
      ],
      { env: this.composeEnvironment(secrets), signal, timeoutMs: 60_000 },
    );
  }

  private composeEnvironment(secrets: DesktopSecrets): NodeJS.ProcessEnv {
    return {
      ...this.baseEnv,
      ...secrets,
      CONFUSE_WEB_IMAGE: this.config.webImage,
      CONFUSE_WORKER_IMAGE: this.config.workerImage,
      CONFUSE_WEB_PORT: String(this.config.webPort),
      CONFUSE_MINIO_PORT: String(this.config.minioPort),
      CONFUSE_MINIO_CONSOLE_PORT: String(this.config.minioConsolePort),
      NEXTAUTH_URL: this.config.webUrl,
      DATABASE_URL: `postgresql://postgres:${secrets.POSTGRES_PASSWORD}@postgres:5432/postgres`,
      LANGFUSE_INIT_ORG_ID: "confuse-local",
      LANGFUSE_INIT_ORG_NAME: "Confuse Local",
      LANGFUSE_INIT_PROJECT_ID: "confuse-local",
      LANGFUSE_INIT_PROJECT_NAME: "Confuse Local",
      LANGFUSE_INIT_USER_EMAIL: "desktop@confuse.local",
      LANGFUSE_INIT_USER_NAME: "Confuse Desktop",
      TELEMETRY_ENABLED: "false",
      LANGFUSE_DISABLE_SIGNUP_ONBOARDING: "true",
    };
  }
}
