import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { Session } from "electron";
import { NodeProcessRunner } from "../supervisor/process";
import { normalizeLocalWebUrl } from "./config";

const AUTH_TOKEN_ACCOUNT = "CONFUSE_DESKTOP_AUTH_TOKEN";
const KEYCHAIN_SERVICE = "com.confuse.desktop";

type CookieDetails = Parameters<Session["cookies"]["set"]>[0];

async function readAuthToken(): Promise<string | null> {
  const result = await new NodeProcessRunner().run("/usr/bin/security", [
    "find-generic-password",
    "-a",
    AUTH_TOKEN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  const token = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  return token || null;
}

function exchangeToken(url: URL, token: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": "0",
        },
      },
      (response) => {
        response.resume();
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error("Desktop session exchange was rejected"));
            return;
          }
          const cookies = response.headers["set-cookie"] ?? [];
          if (cookies.length === 0) {
            reject(new Error("Desktop session exchange returned no cookies"));
            return;
          }
          resolve(cookies);
        });
      },
    );
    request.setTimeout(10_000, () => {
      request.destroy(new Error("Desktop session exchange timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  if (pathname.endsWith("/")) return pathname;
  return pathname.slice(0, pathname.lastIndexOf("/") + 1) || "/";
}

function parseCookie(header: string, requestUrl: URL): CookieDetails | null {
  const [pair, ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;

  const cookie: CookieDetails = {
    url: requestUrl.origin,
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    path: defaultCookiePath(requestUrl.pathname),
  };
  let expires: number | undefined;

  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    const name = (separator === -1 ? attribute : attribute.slice(0, separator))
      .trim()
      .toLowerCase();
    const value = separator === -1 ? "" : attribute.slice(separator + 1).trim();

    switch (name) {
      case "domain":
        if (value) cookie.domain = value;
        break;
      case "path":
        cookie.path = value || "/";
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        if (value.toLowerCase() === "strict") cookie.sameSite = "strict";
        if (value.toLowerCase() === "lax") cookie.sameSite = "lax";
        if (value.toLowerCase() === "none") cookie.sameSite = "no_restriction";
        break;
      case "max-age": {
        const maxAge = Number(value);
        if (Number.isFinite(maxAge))
          cookie.expirationDate = Date.now() / 1000 + maxAge;
        break;
      }
      case "expires": {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) expires = parsed / 1000;
        break;
      }
    }
  }

  if (cookie.expirationDate === undefined && expires !== undefined)
    cookie.expirationDate = expires;
  return cookie;
}

export async function authenticateLocalSession(
  candidate: string,
  session: Session,
): Promise<boolean> {
  try {
    const normalized = normalizeLocalWebUrl(candidate);
    if (!normalized) return false;
    const url = new URL("/api/desktop/session", normalized);
    const token = await readAuthToken();
    if (!token) return false;

    const headers = await exchangeToken(url, token);
    const cookies = headers
      .map((header) => parseCookie(header, url))
      .filter((cookie) => cookie !== null);
    if (cookies.length === 0) return false;
    await Promise.all(cookies.map((cookie) => session.cookies.set(cookie)));
    return true;
  } catch {
    return false;
  }
}
