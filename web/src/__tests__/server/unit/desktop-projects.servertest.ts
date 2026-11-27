import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationId, ProjectId, untag } from "@langfuse/shared/rbac";

const mocks = vi.hoisted(() => ({
  env: {
    LANGFUSE_INIT_ORG_ID: "confuse-local",
    LANGFUSE_INIT_USER_EMAIL: "desktop@confuse.local",
  },
  user: { findUnique: vi.fn() },
  organizationMembership: { findFirst: vi.fn() },
  project: { findUnique: vi.fn(), upsert: vi.fn() },
  saveProjectMembership: vi.fn(),
  createApiKey: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/src/env.mjs", () => ({ env: mocks.env }));
vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    user: mocks.user,
    organizationMembership: mocks.organizationMembership,
    project: mocks.project,
  },
}));
vi.mock("@langfuse/shared/memberships", () => ({
  saveProjectMembership: mocks.saveProjectMembership,
}));
vi.mock("@langfuse/shared/src/server/auth/apiKeys", () => ({
  createApiKey: mocks.createApiKey,
}));
vi.mock("@/src/features/audit-logs/auditLog", () => ({
  auditLog: mocks.auditLog,
}));

import handler from "@/src/pages/api/desktop/projects";

const cases = [
  ["kimi-code", "confuse-kimi-code", "Kimi Code"],
  ["chatgpt-codex", "confuse-chatgpt-codex", "ChatGPT Codex"],
  ["claude-code", "confuse-claude-code", "Claude Code"],
  ["deepseek-harness", "confuse-deepseek-harness", "DeepSeek Harness"],
] as const;

function request(
  agent: unknown,
  options: {
    authorization?: string;
    host?: string;
    remoteAddress?: string;
  } = {},
) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: "POST",
    body: { agent, organizationId: "confuse-desktop" },
  });
  req.headers.authorization = options.authorization ?? "Bearer synthetic-token";
  req.headers.host = options.host ?? "127.0.0.1:3000";
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: options.remoteAddress ?? "127.0.0.1",
  });
  return { req, res };
}

describe("desktop Agent projects API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONFUSE_DESKTOP_AUTH_TOKEN", "synthetic-token");
    mocks.user.findUnique.mockResolvedValue({ id: "desktop-user" });
    mocks.organizationMembership.findFirst.mockResolvedValue({
      id: "org-membership",
    });
    mocks.project.findUnique.mockResolvedValue(null);
    mocks.project.upsert.mockImplementation(async ({ create }) => ({
      id: create.id,
      name: create.name,
    }));
    mocks.createApiKey.mockImplementation(async (_prisma, options) => {
      const scope = untag(options.scope);
      return {
        id: `key-${scope}`,
        publicKey: `pk-lf-${scope}`,
        secretKey: `sk-lf-${scope}`,
        displaySecretKey: "sk-lf-...",
        note: "Agent project key",
        createdAt: new Date(0),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(cases)(
    "creates an isolated project and scoped credentials for %s",
    async (agent, projectId, projectName) => {
      const { req, res } = request(agent);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        agent,
        projectId,
        projectName,
        publicKey: `pk-lf-${projectId}`,
        secretKey: `sk-lf-${projectId}`,
      });
      expect(mocks.project.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: projectId },
          update: {},
        }),
      );
      expect(mocks.createApiKey.mock.calls[0]?.[1]).toMatchObject({
        tenant: OrganizationId("confuse-desktop"),
        scope: ProjectId(projectId),
      });
      expect(mocks.saveProjectMembership).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectId, role: "OWNER" }),
      );
      expect(JSON.stringify(mocks.auditLog.mock.calls)).not.toContain("sk-lf-");
    },
  );

  it("reuses an existing project without another project audit record", async () => {
    mocks.project.findUnique.mockResolvedValue({ orgId: "confuse-desktop" });
    const { req, res } = request("kimi-code");

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "apiKey", action: "create" }),
    );
  });

  it.each([
    { options: { host: "example.com" }, status: 403 },
    { options: { remoteAddress: "192.0.2.10" }, status: 403 },
    { options: { authorization: "Bearer wrong" }, status: 401 },
  ])(
    "rejects an untrusted request without creating a project",
    async ({ options, status }) => {
      const { req, res } = request("kimi-code", options);

      await handler(req, res);

      expect(res.statusCode).toBe(status);
      expect(mocks.project.upsert).not.toHaveBeenCalled();
      expect(mocks.createApiKey).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown Agent and a project from another organization", async () => {
    const invalid = request("other-agent");
    await handler(invalid.req, invalid.res);
    expect(invalid.res.statusCode).toBe(400);

    mocks.project.findUnique.mockResolvedValue({ orgId: "other-org" });
    const crossTenant = request("kimi-code");
    await handler(crossTenant.req, crossTenant.res);

    expect(crossTenant.res.statusCode).toBe(403);
    expect(mocks.project.upsert).not.toHaveBeenCalled();
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("does not create a project when the initialized owner is unavailable", async () => {
    mocks.organizationMembership.findFirst.mockResolvedValue(null);
    const { req, res } = request("kimi-code");

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(mocks.project.upsert).not.toHaveBeenCalled();
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
});
