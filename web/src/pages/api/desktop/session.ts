import type { NextApiRequest, NextApiResponse } from "next";
import type { CookieOption } from "next-auth";
import { encode } from "next-auth/jwt";
import { env } from "@/src/env.mjs";
import {
  hasLoopbackHost,
  hasValidBearerToken,
  isDesktopPeer,
} from "@/src/features/desktop/server/request-auth";
import { getAuthOptions } from "@/src/server/auth";
import { prisma } from "@langfuse/shared/src/db";

const serializeSessionCookie = (
  cookie: CookieOption,
  value: string,
  maxAge: number,
): string => {
  const parts = [
    `${cookie.name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.floor(maxAge)}`,
  ];
  if (cookie.options.domain) parts.push(`Domain=${cookie.options.domain}`);
  parts.push(`Path=${cookie.options.path ?? "/"}`);
  parts.push(`Expires=${new Date(Date.now() + maxAge * 1_000).toUTCString()}`);
  if (cookie.options.httpOnly) parts.push("HttpOnly");
  if (cookie.options.secure) parts.push("Secure");
  if (cookie.options.sameSite) {
    const sameSite =
      cookie.options.sameSite === true ? "strict" : cookie.options.sameSite;
    parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`);
  }
  return parts.join("; ");
};

export default async function desktopSession(
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

  const initializedEmail = env.LANGFUSE_INIT_USER_EMAIL?.toLowerCase();
  if (!initializedEmail || !env.NEXTAUTH_SECRET) {
    res.status(404).json({ message: "Not found" });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { email: initializedEmail },
    select: { id: true, name: true, email: true, image: true },
  });
  if (!user?.email) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const authOptions = await getAuthOptions();
  const jwtCallback = authOptions.callbacks?.jwt;
  const sessionCookie = authOptions.cookies?.sessionToken;
  const maxAge = authOptions.session?.maxAge;
  if (!jwtCallback || !sessionCookie || !maxAge) {
    res.status(500).json({ message: "Session configuration unavailable" });
    return;
  }
  const token = await jwtCallback({
    token: {
      sub: user.id,
      name: user.name,
      email: user.email,
      picture: user.image,
    },
    user,
    account: null,
    trigger: "signIn",
  });
  const encodeJwt = authOptions.jwt?.encode ?? encode;
  const sessionToken = await encodeJwt({
    token,
    secret: env.NEXTAUTH_SECRET,
    maxAge,
  });
  res.setHeader(
    "Set-Cookie",
    serializeSessionCookie(sessionCookie, sessionToken, maxAge),
  );
  res.status(204).end();
}
