import path from "node:path";
import { app } from "electron";

const DEFAULT_WEB_URL = "http://127.0.0.1:3000";

export function supervisorSocketPath(): string {
  return (
    process.env.CONFUSE_SUPERVISOR_SOCKET ??
    process.env.CONFUSE_SOCKET_PATH ??
    path.join(app.getPath("userData"), "supervisor.sock")
  );
}

export function normalizeLocalWebUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !loopbackHosts.has(url.hostname) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function initialWebUrl(): string {
  const configured =
    process.env.NODE_ENV === "development"
      ? (process.env.CONFUSE_DEV_WEB_URL ?? process.env.CONFUSE_WEB_URL)
      : process.env.CONFUSE_WEB_URL;

  return normalizeLocalWebUrl(configured) ?? DEFAULT_WEB_URL;
}
