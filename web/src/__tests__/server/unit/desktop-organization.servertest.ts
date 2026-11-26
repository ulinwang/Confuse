import { createMocks, type RequestMethod } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { LANGFUSE_INIT_USER_EMAIL: "desktop@confuse.local" },
  user: { findUnique: vi.fn() },
  organizationMembership: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn(), upsert: vi.fn() },
  apiKey: { deleteMany: vi.fn() },
  saveOrgMembership: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/src/env.mjs", () => ({ env: mocks.env }));
vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    user: mocks.user,
    organizationMembership: mocks.organizationMembership,
    organization: mocks.organization,
    apiKey: mocks.apiKey,
  },
}));
vi.mock("@langfuse/shared/memberships", () => ({
  saveOrgMembership: mocks.saveOrgMembership,
}));
vi.mock("@/src/features/audit-logs/auditLog", () => ({
  auditLog: mocks.auditLog,
}));

import handler from "@/src/pages/api/desktop/organization";

function request(method: RequestMethod, name?: string) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method,
    body: name ? { name } : undefined,
  });
  req.headers.authorization = "Bearer synthetic-token";
  req.headers.host = "127.0.0.1:3000";
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: "127.0.0.1",
  });
  return { req, res };
}

describe("desktop organization API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONFUSE_DESKTOP_AUTH_TOKEN", "synthetic-token");
    mocks.user.findUnique.mockResolvedValue({ id: "desktop-user" });
    mocks.organizationMembership.findFirst.mockResolvedValue({
      id: "membership",
    });
    mocks.organization.findUnique.mockResolvedValue(null);
    mocks.organization.upsert.mockImplementation(async ({ create }) => ({
      id: "confuse-desktop",
      name: create.name,
    }));
    mocks.apiKey.deleteMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the organization and owner before any Agent project", async () => {
    const { req, res } = request("POST", "My Organization");

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({
      id: "confuse-desktop",
      name: "My Organization",
    });
    expect(mocks.saveOrgMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "confuse-desktop",
        userId: "desktop-user",
        role: "OWNER",
      }),
    );
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "organization",
        action: "create",
      }),
    );
    expect(mocks.organization.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveOrgMembership.mock.invocationCallOrder[0],
    );
  });

  it("revokes only Confuse-created Agent keys and preserves projects", async () => {
    mocks.organization.findUnique.mockResolvedValue({ id: "confuse-desktop" });
    const { req, res } = request("DELETE");

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(mocks.apiKey.deleteMany).toHaveBeenCalledTimes(4);
    for (const [{ where }] of mocks.apiKey.deleteMany.mock.calls) {
      expect(where).toMatchObject({
        project: { orgId: "confuse-desktop" },
        note: { startsWith: "Confuse " },
      });
    }
    expect(mocks.auditLog).toHaveBeenCalledTimes(4);
    expect(mocks.organization.upsert).not.toHaveBeenCalled();
  });

  it("allows cleanup when a legacy installation has no organization", async () => {
    const { req, res } = request("DELETE");

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(mocks.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  it("does not create an organization or revoke keys without an initialized owner", async () => {
    mocks.user.findUnique.mockResolvedValue(null);
    const create = request("POST", "My Organization");
    await handler(create.req, create.res);
    expect(create.res.statusCode).toBe(404);
    expect(mocks.organization.upsert).not.toHaveBeenCalled();

    mocks.user.findUnique.mockResolvedValue({ id: "desktop-user" });
    mocks.organization.findUnique.mockResolvedValue({ id: "confuse-desktop" });
    mocks.organizationMembership.findFirst.mockResolvedValue(null);
    const revoke = request("DELETE");
    await handler(revoke.req, revoke.res);
    expect(revoke.res.statusCode).toBe(404);
    expect(mocks.apiKey.deleteMany).not.toHaveBeenCalled();
  });
});
