import { createHash, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";

export const isDesktopPeer = (address: string | undefined): boolean => {
  if (address === "::1") return true;
  const ipv4Address = address?.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  return Boolean(
    ipv4Address &&
    isIPv4(ipv4Address) &&
    (ipv4Address.startsWith("127.") || ipv4Address === "192.168.65.1"),
  );
};

export const hasLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

export const hasValidBearerToken = (
  authorization: string | undefined,
  expectedToken: string,
): boolean => {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  if (!match) return false;
  const suppliedDigest = createHash("sha256").update(match[1]).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
};
