import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SupervisorConfig {
  stateDir: string;
  databasePath: string;
  socketPath: string;
  resourceDir: string;
  composeFile: string;
  launchAgentTemplatePath: string;
  supervisorEntryPath: string;
  composeProject: "confuse";
  webImage: string;
  workerImage: string;
  webPort: number;
  minioPort: number;
  minioConsolePort: number;
  webUrl: string;
  startupTimeoutMs: number;
  outboxPollMs: number;
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function readSupervisorConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupervisorConfig {
  const stateDir = resolve(
    env.CONFUSE_STATE_DIR ??
      join(homedir(), "Library", "Application Support", "Confuse"),
  );
  const resourceDir = env.CONFUSE_RESOURCE_DIR
    ? resolve(env.CONFUSE_RESOURCE_DIR)
    : resolve(dirname(process.argv[1]), "../../resources");
  const webPort = integer(env.CONFUSE_WEB_PORT, 3000, "CONFUSE_WEB_PORT");
  return {
    stateDir,
    databasePath: resolve(
      env.CONFUSE_DATABASE_PATH ?? join(stateDir, "state.sqlite"),
    ),
    socketPath: resolve(
      env.CONFUSE_SUPERVISOR_SOCKET ??
        env.CONFUSE_SOCKET_PATH ??
        join(stateDir, "supervisor.sock"),
    ),
    resourceDir,
    composeFile: resolve(
      env.CONFUSE_COMPOSE_FILE ?? join(resourceDir, "compose.yml"),
    ),
    launchAgentTemplatePath: resolve(
      env.CONFUSE_LAUNCH_AGENT_TEMPLATE ??
        join(resourceDir, "com.confuse.supervisor.plist"),
    ),
    supervisorEntryPath: resolve(
      env.CONFUSE_SUPERVISOR_ENTRY ?? process.argv[1],
    ),
    composeProject: "confuse",
    webImage: env.CONFUSE_WEB_IMAGE ?? "ghcr.io/ulinwang/confuse-web:0.1.0",
    workerImage:
      env.CONFUSE_WORKER_IMAGE ?? "ghcr.io/ulinwang/confuse-worker:0.1.0",
    webPort,
    minioPort: integer(env.CONFUSE_MINIO_PORT, 9090, "CONFUSE_MINIO_PORT"),
    minioConsolePort: integer(
      env.CONFUSE_MINIO_CONSOLE_PORT,
      9091,
      "CONFUSE_MINIO_CONSOLE_PORT",
    ),
    webUrl: `http://127.0.0.1:${webPort}`,
    startupTimeoutMs: positiveInteger(
      env.CONFUSE_STARTUP_TIMEOUT_MS,
      180_000,
      "CONFUSE_STARTUP_TIMEOUT_MS",
    ),
    outboxPollMs: positiveInteger(
      env.CONFUSE_OUTBOX_POLL_MS,
      2_000,
      "CONFUSE_OUTBOX_POLL_MS",
    ),
  };
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Desktop state path is not a private directory: ${path}`);
  }
  chmodSync(path, 0o700);
}
