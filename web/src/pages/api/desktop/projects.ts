import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { DESKTOP_ORGANIZATION_ID } from "@/src/features/desktop/server/organization";
import {
  desktopAgentSchema,
  ensureDesktopAgentProject,
} from "@/src/features/desktop/server/agent-projects";
import {
  hasLoopbackHost,
  hasValidBearerToken,
  isDesktopPeer,
} from "@/src/features/desktop/server/request-auth";

export default async function desktopProjects(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const desktopAuthToken = process.env.CONFUSE_DESKTOP_AUTH_TOKEN;
  if (!desktopAuthToken) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  if (
    !hasLoopbackHost(req.headers.host) ||
    !isDesktopPeer(req.socket.remoteAddress)
  ) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (!hasValidBearerToken(req.headers.authorization, desktopAuthToken)) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const parsed = z
    .object({
      agent: desktopAgentSchema,
      organizationId: z.literal(DESKTOP_ORGANIZATION_ID),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid Agent or organization" });
    return;
  }

  const result = await ensureDesktopAgentProject(
    parsed.data.agent,
    parsed.data.organizationId,
  );
  if (result === "unavailable") {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (result === "forbidden") {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  res.status(200).json(result);
}
