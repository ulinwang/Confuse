import { env } from "@/src/env.mjs";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { prisma } from "@langfuse/shared/src/db";
import { saveOrgMembership } from "@langfuse/shared/memberships";

export const DESKTOP_ORGANIZATION_ID = "confuse-desktop";

const agentProjectIds = [
  "confuse-kimi-code",
  "confuse-chatgpt-codex",
  "confuse-claude-code",
  "confuse-deepseek-harness",
];

async function initializedUser() {
  const email = env.LANGFUSE_INIT_USER_EMAIL?.toLowerCase();
  if (!email) return undefined;
  return prisma.user.findUnique({ where: { email }, select: { id: true } });
}

export async function requireDesktopOwner(orgId: string) {
  const user = await initializedUser();
  if (!user) return undefined;
  const orgMembership = await prisma.organizationMembership.findFirst({
    where: { userId: user.id, orgId, role: "OWNER" },
    select: { id: true },
  });
  return orgMembership ? { user, orgMembership } : undefined;
}

export async function ensureDesktopOrganization(name: string) {
  const user = await initializedUser();
  if (!user) return "unavailable" as const;
  const existing = await prisma.organization.findUnique({
    where: { id: DESKTOP_ORGANIZATION_ID },
    select: { id: true },
  });
  const organization = await prisma.organization.upsert({
    where: { id: DESKTOP_ORGANIZATION_ID },
    create: { id: DESKTOP_ORGANIZATION_ID, name },
    update: {},
    select: { id: true, name: true },
  });
  await saveOrgMembership(prisma, {
    userId: user.id,
    orgId: organization.id,
    role: "OWNER",
  });
  if (!existing) {
    await auditLog({
      resourceType: "organization",
      resourceId: organization.id,
      action: "create",
      orgId: organization.id,
      orgRole: "OWNER",
      userId: user.id,
    });
  }
  return organization;
}

export async function revokeDesktopAgentKeys() {
  const organization = await prisma.organization.findUnique({
    where: { id: DESKTOP_ORGANIZATION_ID },
    select: { id: true },
  });
  if (!organization) return "not-found" as const;
  const owner = await requireDesktopOwner(DESKTOP_ORGANIZATION_ID);
  if (!owner) return "unavailable" as const;
  for (const projectId of agentProjectIds) {
    const revoked = await prisma.apiKey.deleteMany({
      where: {
        projectId,
        project: { orgId: DESKTOP_ORGANIZATION_ID },
        note: { startsWith: "Confuse " },
      },
    });
    if (revoked.count > 0) {
      await auditLog({
        resourceType: "apiKey",
        resourceId: projectId,
        action: "revokeAgentKeys",
        orgId: DESKTOP_ORGANIZATION_ID,
        projectId,
        orgRole: "OWNER",
        userId: owner.user.id,
      });
    }
  }
}
