import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProjectRegistry } from "./agent-projects";
import { clearAgentCredentials, MemorySecretStore } from "./keychain";
import { DesktopStore } from "./store";

const directories: string[] = [];
const stores: DesktopStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("AgentProjectRegistry", () => {
  it("provisions isolated projects after organization setup and reuses credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "confuse-agent-projects-"));
    directories.push(root);
    const store = new DesktopStore(join(root, "state.sqlite"));
    stores.push(store);
    const secrets = new MemorySecretStore();
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/organization")) {
          return new Response(
            JSON.stringify({ id: "confuse-desktop", name: "Confuse" }),
            { status: 200 },
          );
        }
        const { agent } = JSON.parse(String(init?.body)) as { agent: string };
        return new Response(
          JSON.stringify({
            agent,
            projectId: `confuse-${agent}`,
            projectName: `${agent} project`,
            publicKey: `pk-lf-${agent}`,
            secretKey: `sk-lf-${agent}`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const registry = new AgentProjectRegistry({
      secrets,
      store,
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetchImpl,
    });

    expect(await registry.ensureOrganization("Confuse")).toEqual({
      id: "confuse-desktop",
      name: "Confuse",
    });
    const kimi = await registry.ensure("kimi-code");
    const claude = await registry.ensure("claude-code");
    expect(await registry.ensure("kimi-code")).toEqual(kimi);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(kimi.id).toBe("confuse-kimi-code");
    expect(claude.id).toBe("confuse-claude-code");
    expect(await secrets.get("CONFUSE_AGENT_KIMI_CODE_SECRET_KEY")).toBe(
      "sk-lf-kimi-code",
    );
    expect(await secrets.get("CONFUSE_AGENT_CLAUDE_CODE_SECRET_KEY")).toBe(
      "sk-lf-claude-code",
    );
    expect(JSON.stringify(store.getAgentProject("kimi-code"))).not.toContain(
      "sk-lf-",
    );
    expect(store.listJobs()).toEqual([]);

    const agentOptions = await registry.clientOptions(
      "kimi-code",
      "confuse-kimi-code",
    );
    expect(agentOptions).toMatchObject({
      publicKey: "pk-lf-kimi-code",
      secretKey: "sk-lf-kimi-code",
    });
    const legacyOptions = await registry.clientOptions("kimi-code");
    expect(legacyOptions.publicKey).not.toBe(agentOptions.publicKey);
    await expect(
      registry.clientOptions("claude-code", "confuse-kimi-code"),
    ).rejects.toThrow("Telemetry project does not match its Agent");
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.redirect === "error"),
    ).toBe(true);

    await registry.revoke();
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  it("rejects mismatched project responses without persisting project metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "confuse-agent-projects-"));
    directories.push(root);
    const store = new DesktopStore(join(root, "state.sqlite"));
    stores.push(store);
    const registry = new AgentProjectRegistry({
      secrets: new MemorySecretStore(),
      store,
      baseUrl: "http://127.0.0.1:3000",
      fetch: async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/organization")
              ? { id: "confuse-desktop", name: "Confuse" }
              : {
                  agent: "claude-code",
                  projectId: "confuse-kimi-code",
                  projectName: "Wrong project",
                  publicKey: "pk-lf-wrong",
                  secretKey: "sk-lf-wrong",
                },
          ),
          { status: 200 },
        ),
    });

    await registry.ensureOrganization("Confuse");
    await expect(registry.ensure("claude-code")).rejects.toThrow(
      "Agent project setup returned an invalid response",
    );
    expect(store.getAgentProject("claude-code")).toBeUndefined();
  });

  it("does not contact the project API before organization creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "confuse-agent-projects-"));
    directories.push(root);
    const store = new DesktopStore(join(root, "state.sqlite"));
    stores.push(store);
    const fetchImpl = vi.fn();
    const registry = new AgentProjectRegistry({
      secrets: new MemorySecretStore(),
      store,
      baseUrl: "http://127.0.0.1:3000",
      fetch: fetchImpl,
    });

    await expect(registry.ensure("kimi-code")).rejects.toThrow(
      "Create the Confuse organization before connecting Agents",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears Agent credentials while preserving data and default project access", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("CONFUSE_DESKTOP_AUTH_TOKEN", "desktop-token");
    await secrets.set("CONFUSE_AGENT_KIMI_CODE_SECRET_KEY", "agent-secret");
    await secrets.set("ENCRYPTION_KEY", "preserve-encryption");
    await secrets.set("LANGFUSE_INIT_PROJECT_SECRET_KEY", "preserve-project");
    await secrets.set("LANGFUSE_INIT_USER_PASSWORD", "preserve-password");

    await clearAgentCredentials(secrets);

    expect(await secrets.get("CONFUSE_DESKTOP_AUTH_TOKEN")).toBeNull();
    expect(await secrets.get("CONFUSE_AGENT_KIMI_CODE_SECRET_KEY")).toBeNull();
    expect(await secrets.get("ENCRYPTION_KEY")).toBe("preserve-encryption");
    expect(await secrets.get("LANGFUSE_INIT_PROJECT_SECRET_KEY")).toBe(
      "preserve-project",
    );
    expect(await secrets.get("LANGFUSE_INIT_USER_PASSWORD")).toBe(
      "preserve-password",
    );
  });
});
