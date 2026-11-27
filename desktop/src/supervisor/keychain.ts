import { randomBytes } from "node:crypto";
import type { ProcessRunner } from "./process";
import { ProcessRunError } from "./process";

const SECRET_KEYS = [
  "POSTGRES_PASSWORD",
  "CLICKHOUSE_PASSWORD",
  "REDIS_AUTH",
  "MINIO_ROOT_PASSWORD",
  "SALT",
  "ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
  "CONFUSE_DESKTOP_AUTH_TOKEN",
  "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
  "LANGFUSE_INIT_PROJECT_SECRET_KEY",
  "LANGFUSE_INIT_USER_PASSWORD",
] as const;

type BuiltInSecretKey = (typeof SECRET_KEYS)[number];
type AgentSecretPrefix =
  | "KIMI_CODE"
  | "CHATGPT_CODEX"
  | "CLAUDE_CODE"
  | "DEEPSEEK_HARNESS";

export type SecretKey =
  | BuiltInSecretKey
  | `CONFUSE_AGENT_${AgentSecretPrefix}_PUBLIC_KEY`
  | `CONFUSE_AGENT_${AgentSecretPrefix}_SECRET_KEY`;
export type DesktopSecrets = Record<BuiltInSecretKey, string>;

export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(key: SecretKey): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: SecretKey): Promise<void> {
    this.values.delete(key);
  }
}

export class MacOsKeychain implements SecretStore {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly service = "com.confuse.desktop",
  ) {}

  async get(key: SecretKey): Promise<string | null> {
    try {
      const result = await this.runner.run("/usr/bin/security", [
        "find-generic-password",
        "-a",
        key,
        "-s",
        this.service,
        "-w",
      ]);
      return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
    } catch (error) {
      if (error instanceof ProcessRunError && error.exitCode === 44)
        return null;
      throw error;
    }
  }

  async set(key: SecretKey, value: string): Promise<void> {
    const encoded = Buffer.from(value, "utf8").toString("base64");
    await this.runner.run("/usr/bin/security", ["-i"], {
      input: `add-generic-password -U -a "${key}" -s "${this.service}" -w ${encoded}\n`,
    });
  }

  async delete(key: SecretKey): Promise<void> {
    try {
      await this.runner.run("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        key,
        "-s",
        this.service,
      ]);
    } catch (error) {
      if (error instanceof ProcessRunError && error.exitCode === 44) return;
      throw error;
    }
  }
}

export async function clearAgentCredentials(store: SecretStore): Promise<void> {
  const keys: SecretKey[] = [
    "CONFUSE_DESKTOP_AUTH_TOKEN",
    "CONFUSE_AGENT_KIMI_CODE_PUBLIC_KEY",
    "CONFUSE_AGENT_KIMI_CODE_SECRET_KEY",
    "CONFUSE_AGENT_CHATGPT_CODEX_PUBLIC_KEY",
    "CONFUSE_AGENT_CHATGPT_CODEX_SECRET_KEY",
    "CONFUSE_AGENT_CLAUDE_CODE_PUBLIC_KEY",
    "CONFUSE_AGENT_CLAUDE_CODE_SECRET_KEY",
    "CONFUSE_AGENT_DEEPSEEK_HARNESS_PUBLIC_KEY",
    "CONFUSE_AGENT_DEEPSEEK_HARNESS_SECRET_KEY",
  ];
  let firstError: unknown;
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function generatedSecret(key: BuiltInSecretKey): string {
  const random = randomBytes(32).toString("hex");
  switch (key) {
    case "LANGFUSE_INIT_PROJECT_PUBLIC_KEY":
      return `pk-lf-${randomBytes(16).toString("hex")}`;
    case "LANGFUSE_INIT_PROJECT_SECRET_KEY":
      return `sk-lf-${randomBytes(16).toString("hex")}`;
    default:
      return random;
  }
}

export async function loadOrCreateSecrets(
  store: SecretStore,
): Promise<DesktopSecrets> {
  const entries: [BuiltInSecretKey, string][] = [];
  for (const key of SECRET_KEYS) {
    let value = await store.get(key);
    if (!value) {
      value = generatedSecret(key);
      await store.set(key, value);
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries) as DesktopSecrets;
}
