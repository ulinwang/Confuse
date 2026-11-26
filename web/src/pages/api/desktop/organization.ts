import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import {
  ensureDesktopOrganization,
  revokeDesktopAgentKeys,
} from "@/src/features/desktop/server/organization";
import {
  hasLoopbackHost,
  hasValidBearerToken,
  isDesktopPeer,
} from "@/src/features/desktop/server/request-auth";

export default async function desktopOrganization(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const desktopAuthToken = process.env.CONFUSE_DESKTOP_AUTH_TOKEN;
  if (!desktopAuthToken) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  if (!["POST", "DELETE"].includes(req.method ?? "")) {
    res.setHeader("Allow", "POST, DELETE");
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

  if (req.method === "DELETE") {
    const revoked = await revokeDesktopAgentKeys();
    if (revoked === "unavailable") {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.status(204).end();
    return;
  }

  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .safeParse(req.body?.name ?? "Confuse");
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid organization name" });
    return;
  }
  const organization = await ensureDesktopOrganization(parsed.data);
  if (organization === "unavailable") {
    res.status(404).json({ message: "Not found" });
    return;
  }
  res.status(200).json(organization);
}
