import { z } from "zod";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { prisma } from "@langfuse/shared/src/db";
import { saveProjectMembership } from "@langfuse/shared/memberships";
import { DESKTOP_ORGANIZATION_ID, requireDesktopOwner } from "./organization";
import {
  OrganizationId,
  ProjectId,
  SystemRoleId,
  UserId,
} from "@langfuse/shared/rbac";
import { createApiKey } from "@langfuse/shared/src/server/auth/apiKeys";

const definitions = {
  "kimi-code": { id: "confuse-kimi-code", name: "Kimi Code" },
  "chatgpt-codex": { id: "confuse-chatgpt-codex", name: "ChatGPT Codex" },
  "claude-code": { id: "confuse-claude-code", name: "Claude Code" },
  "deepseek-harness": {
    id: "confuse-deepseek-harness",
    name: "DeepSeek Harness",
  },
} as const;

export const desktopAgentSchema = z.enum([
  "kimi-code",
  "chatgpt-codex",
  "claude-code",
  "deepseek-harness",
]);

export type DesktopAgentKind = z.infer<typeof desktopAgentSchema>;

export async function ensureDesktopAgentProject(
  agent: DesktopAgentKind,
  organizationId: string,
) {
  if (organizationId !== DESKTOP_ORGANIZATION_ID) return "forbidden" as const;
  const owner = await requireDesktopOwner(organizationId);
  if (!owner) return "unavailable" as const;
  const { user, orgMembership } = owner;
  const orgId = organizationId;
  const definition = definitions[agent];
  const existing = await prisma.project.findUnique({
    where: { id: definition.id },
    select: { orgId: true },
  });
  if (existing && existing.orgId !== orgId) return "forbidden" as const;
  const project = await prisma.project.upsert({
    where: { id: definition.id },
    create: { id: definition.id, name: definition.name, orgId },
    update: {},
    select: { id: true, name: true },
  });
  await saveProjectMembership(prisma, {
    orgId,
    userId: user.id,
    orgMembershipId: orgMembership.id,
    projectId: project.id,
    role: "OWNER",
  });
  if (!existing) {
    await auditLog({
      resourceType: "project",
      resourceId: project.id,
      action: "create",
      orgId,
      projectId: project.id,
      orgRole: "OWNER",
      userId: user.id,
      after: { agent },
    });
  }

  const apiKey = await createApiKey(prisma, {
    tenant: OrganizationId(orgId),
    scope: ProjectId(project.id),
    role: SystemRoleId("LEGACY_PROJECT_API_KEY"),
    createdBy: UserId(user.id),
    name: `Confuse ${project.name}`,
  });
  await auditLog({
    resourceType: "apiKey",
    resourceId: apiKey.id,
    action: "create",
    orgId,
    projectId: project.id,
    orgRole: "OWNER",
    userId: user.id,
    after: { agent },
  });
  return {
    agent,
    projectId: project.id,
    projectName: project.name,
    publicKey: apiKey.publicKey,
    secretKey: apiKey.secretKey,
  };
}
