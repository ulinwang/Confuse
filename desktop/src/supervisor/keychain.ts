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

export type SecretKey = (typeof SECRET_KEYS)[number];
export type DesktopSecrets = Record<SecretKey, string>;

export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(key: SecretKey): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
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
      input: `add-generic-password -U -a "${key}" -s "${this.service}" -w ${encoded}\nexit\n`,
    });
  }
}

function generatedSecret(key: SecretKey): string {
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
  const entries: [SecretKey, string][] = [];
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
