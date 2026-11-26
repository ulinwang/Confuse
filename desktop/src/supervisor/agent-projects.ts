import { z } from "zod";
import {
  AGENT_KINDS,
  type AgentKind,
  type AgentProject,
  type DesktopOrganization,
} from "../shared/contracts";
import {
  loadOrCreateSecrets,
  type SecretKey,
  type SecretStore,
} from "./keychain";
import type { DesktopStore } from "./store";
import {
  validateLocalLangfuseBaseUrl,
  type NodeLangfuseV6Options,
} from "./telemetry/langfuse-v6";

const DESKTOP_ORGANIZATION_ID = "confuse-desktop";

export interface AgentProjects {
  ensureOrganization(name: string): Promise<DesktopOrganization>;
  ensure(kind: AgentKind): Promise<AgentProject>;
  clientOptions(
    kind: AgentKind,
    projectId?: string,
  ): Promise<NodeLangfuseV6Options>;
  revoke(): Promise<void>;
}

const projectIds: Record<AgentKind, string> = {
  "kimi-code": "confuse-kimi-code",
  "chatgpt-codex": "confuse-chatgpt-codex",
  "claude-code": "confuse-claude-code",
  "deepseek-harness": "confuse-deepseek-harness",
};

export function agentProjectId(kind: AgentKind): string {
  return projectIds[kind];
}

const accountNames: Record<
  AgentKind,
  { publicKey: SecretKey; secretKey: SecretKey }
> = {
  "kimi-code": {
    publicKey: "CONFUSE_AGENT_KIMI_CODE_PUBLIC_KEY",
    secretKey: "CONFUSE_AGENT_KIMI_CODE_SECRET_KEY",
  },
  "chatgpt-codex": {
    publicKey: "CONFUSE_AGENT_CHATGPT_CODEX_PUBLIC_KEY",
    secretKey: "CONFUSE_AGENT_CHATGPT_CODEX_SECRET_KEY",
  },
  "claude-code": {
    publicKey: "CONFUSE_AGENT_CLAUDE_CODE_PUBLIC_KEY",
    secretKey: "CONFUSE_AGENT_CLAUDE_CODE_SECRET_KEY",
  },
  "deepseek-harness": {
    publicKey: "CONFUSE_AGENT_DEEPSEEK_HARNESS_PUBLIC_KEY",
    secretKey: "CONFUSE_AGENT_DEEPSEEK_HARNESS_SECRET_KEY",
  },
};

const responseSchema = z
  .object({
    agent: z.enum(AGENT_KINDS),
    projectId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    projectName: z.string().min(1).max(100),
    publicKey: z.string().startsWith("pk-lf-").max(256),
    secretKey: z.string().startsWith("sk-lf-").max(256),
  })
  .strict();
const organizationSchema = z
  .object({
    id: z.literal(DESKTOP_ORGANIZATION_ID),
    name: z.string().min(1).max(80),
  })
  .strict();

export class AgentProjectRegistry implements AgentProjects {
  private readonly pending = new Map<AgentKind, Promise<AgentProject>>();
  private organizationPending?: Promise<DesktopOrganization>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      secrets: SecretStore;
      store: DesktopStore;
      baseUrl: string;
      fetch?: typeof fetch;
      signal?: AbortSignal;
    },
  ) {
    this.baseUrl = validateLocalLangfuseBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  ensureOrganization(name: string): Promise<DesktopOrganization> {
    const existing = this.options.store.getOrganization();
    if (existing) return Promise.resolve(existing);
    if (this.organizationPending) return this.organizationPending;
    const pending = this.createOrganization(name);
    this.organizationPending = pending;
    return pending.finally(() => {
      if (this.organizationPending === pending) {
        this.organizationPending = undefined;
      }
    });
  }

  async ensure(kind: AgentKind): Promise<AgentProject> {
    if (!this.options.store.getOrganization()) {
      throw new Error(
        "Create the Confuse organization before connecting Agents",
      );
    }
    const existing = this.pending.get(kind);
    if (existing) return existing;
    const pending = this.ensureProject(kind);
    this.pending.set(kind, pending);
    return pending.finally(() => {
      if (this.pending.get(kind) === pending) this.pending.delete(kind);
    });
  }

  async clientOptions(
    kind: AgentKind,
    projectId?: string,
  ): Promise<NodeLangfuseV6Options> {
    if (projectId === undefined) {
      const secrets = await loadOrCreateSecrets(this.options.secrets);
      return {
        baseUrl: this.baseUrl,
        publicKey: secrets.LANGFUSE_INIT_PROJECT_PUBLIC_KEY,
        secretKey: secrets.LANGFUSE_INIT_PROJECT_SECRET_KEY,
      };
    }
    const project = await this.ensure(kind);
    if (project.id !== projectId) {
      throw new Error("Telemetry project does not match its Agent");
    }
    const accounts = accountNames[kind];
    const [publicKey, secretKey] = await Promise.all([
      this.options.secrets.get(accounts.publicKey),
      this.options.secrets.get(accounts.secretKey),
    ]);
    if (!publicKey || !secretKey) {
      throw new Error("Agent project credentials are unavailable");
    }
    return { baseUrl: this.baseUrl, publicKey, secretKey };
  }

  async revoke(): Promise<void> {
    const response = await this.request("/api/desktop/organization", {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(
        `Agent project cleanup failed with HTTP ${response.status}`,
      );
    }
  }

  private async createOrganization(name: string): Promise<DesktopOrganization> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      throw new Error("Organization name must contain 1 to 80 characters");
    }
    const response = await this.request("/api/desktop/organization", {
      method: "POST",
      body: JSON.stringify({ name: normalized }),
    });
    if (!response.ok) {
      throw new Error(`Organization setup failed with HTTP ${response.status}`);
    }
    const parsed = organizationSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success) {
      throw new Error("Organization setup returned an invalid response");
    }
    const organization = parsed.data;
    this.options.store.saveOrganization(organization);
    return organization;
  }

  private async ensureProject(kind: AgentKind): Promise<AgentProject> {
    const organization = this.options.store.getOrganization();
    if (!organization) {
      throw new Error(
        "Create the Confuse organization before connecting Agents",
      );
    }
    const previous = this.options.store.getAgentProject(kind);
    const accounts = accountNames[kind];
    const [storedPublicKey, storedSecretKey] = await Promise.all([
      this.options.secrets.get(accounts.publicKey),
      this.options.secrets.get(accounts.secretKey),
    ]);
    if (previous && storedPublicKey && storedSecretKey) return previous;

    const response = await this.request("/api/desktop/projects", {
      method: "POST",
      body: JSON.stringify({ agent: kind, organizationId: organization.id }),
    });
    if (!response.ok) {
      throw new Error(
        `Agent project setup failed with HTTP ${response.status}`,
      );
    }
    const parsed = responseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (
      !parsed.success ||
      parsed.data.agent !== kind ||
      parsed.data.projectId !== projectIds[kind]
    ) {
      throw new Error("Agent project setup returned an invalid response");
    }
    await Promise.all([
      this.options.secrets.set(accounts.publicKey, parsed.data.publicKey),
      this.options.secrets.set(accounts.secretKey, parsed.data.secretKey),
    ]);
    const project = {
      kind,
      id: parsed.data.projectId,
      name: parsed.data.projectName,
    };
    this.options.store.saveAgentProject(project);
    return project;
  }

  private async request(
    path: string,
    init: { method: "POST" | "DELETE"; body?: string },
  ): Promise<Response> {
    const secrets = await loadOrCreateSecrets(this.options.secrets);
    const headers: Record<string, string> = {
      authorization: `Bearer ${secrets.CONFUSE_DESKTOP_AUTH_TOKEN}`,
    };
    if (init.body) headers["content-type"] = "application/json";
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      redirect: "error",
      signal: this.options.signal
        ? AbortSignal.any([this.options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  }
}
