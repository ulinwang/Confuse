import { createMocks, type RequestMethod } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import type { NextAuthOptions } from "next-auth";
import { decode } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DESKTOP_AUTH_TOKEN = "test-desktop-auth-token";
const NEXTAUTH_SECRET = "test-nextauth-secret";
const LOGIN_AT = 1_700_000_000_000;

const mocks = vi.hoisted(() => ({
  getAuthOptions: vi.fn(),
  jwt: vi.fn(),
  findUser: vi.fn(),
  env: {
    NEXTAUTH_SECRET: "test-nextauth-secret",
    LANGFUSE_INIT_USER_EMAIL: "desktop@confuse.local",
  },
}));

vi.mock("@/src/env.mjs", () => ({ env: mocks.env }));
vi.mock("@/src/server/auth", () => ({
  getAuthOptions: mocks.getAuthOptions,
}));
vi.mock("@langfuse/shared/src/db", () => ({
  prisma: { user: { findUnique: mocks.findUser } },
}));

import handler from "@/src/pages/api/desktop/session";

function authOptions(secure = false): NextAuthOptions {
  return {
    providers: [],
    session: { strategy: "jwt", maxAge: 3_600 },
    callbacks: { jwt: mocks.jwt },
    cookies: {
      sessionToken: {
        name: secure
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure,
        },
      },
    },
  };
}

function request(
  options: {
    method?: RequestMethod;
    remoteAddress?: string;
    authorization?: string;
  } = {},
) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: options.method ?? "POST",
  });
  Object.defineProperty(req.socket, "remoteAddress", {
    configurable: true,
    value: "remoteAddress" in options ? options.remoteAddress : "127.0.0.1",
  });
  req.headers.authorization =
    options.authorization ?? `Bearer ${DESKTOP_AUTH_TOKEN}`;
  req.headers["x-forwarded-for"] = "127.0.0.1";
  return { req, res };
}

function sessionCookie(res: NextApiResponse, secure = false) {
  const header = res.getHeader("Set-Cookie");
  expect(typeof header).toBe("string");
  const cookie = header as string;
  const expectedName = secure
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";
  expect(cookie).toContain(`${expectedName}=`);
  return {
    attributes: cookie.split("; ").slice(1),
    value: decodeURIComponent(
      cookie.split(";")[0].slice(expectedName.length + 1),
    ),
  };
}

describe("desktop session API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONFUSE_DESKTOP_AUTH_TOKEN", DESKTOP_AUTH_TOKEN);
    mocks.getAuthOptions.mockImplementation(async () => authOptions());
    mocks.jwt.mockImplementation(async ({ token }) => ({
      ...token,
      loginAt: LOGIN_AT,
    }));
    mocks.findUser.mockResolvedValue({
      id: "desktop-user",
      name: "Confuse Desktop",
      email: "desktop@confuse.local",
      image: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues a valid NextAuth JWT using the configured login callback and cookie attributes", async () => {
    const { req, res } = request();

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(res._getData()).toBe("");
    expect(JSON.stringify(res._getHeaders())).not.toContain(DESKTOP_AUTH_TOKEN);
    const cookie = sessionCookie(res);
    expect(cookie.attributes).toEqual(
      expect.arrayContaining([
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=3600",
      ]),
    );
    expect(cookie.attributes).not.toContain("Secure");
    await expect(
      decode({ token: cookie.value, secret: NEXTAUTH_SECRET }),
    ).resolves.toMatchObject({
      sub: "desktop-user",
      name: "Confuse Desktop",
      email: "desktop@confuse.local",
      picture: null,
      loginAt: LOGIN_AT,
    });
    expect(mocks.jwt).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "signIn",
        account: null,
        token: expect.objectContaining({ sub: "desktop-user" }),
      }),
    );
    expect(mocks.findUser).toHaveBeenCalledWith({
      where: { email: "desktop@confuse.local" },
      select: { id: true, name: true, email: true, image: true },
    });
  });

  it("preserves the configured Secure cookie attribute", async () => {
    mocks.getAuthOptions.mockImplementation(async () => authOptions(true));
    const { req, res } = request({ remoteAddress: "::1" });

    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(sessionCookie(res, true).attributes).toContain("Secure");
  });

  it("is unavailable without the desktop auth token configuration", async () => {
    vi.stubEnv("CONFUSE_DESKTOP_AUTH_TOKEN", "");
    const { req, res } = request();

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(mocks.getAuthOptions).not.toHaveBeenCalled();
    expect(res.getHeader("Set-Cookie")).toBeUndefined();
  });

  it.each(["192.0.2.10", "::2", undefined])(
    "rejects non-loopback peer %s even with a forwarded loopback address",
    async (remoteAddress) => {
      const { req, res } = request({ remoteAddress });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mocks.getAuthOptions).not.toHaveBeenCalled();
      expect(res.getHeader("Set-Cookie")).toBeUndefined();
    },
  );

  it.each([
    "Bearer wrong-token-with-a-different-length",
    "Basic test-desktop-auth-token",
    "Bearer ",
  ])(
    "rejects invalid authorization without issuing a cookie",
    async (authorization) => {
      const { req, res } = request({ authorization });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(mocks.getAuthOptions).not.toHaveBeenCalled();
      expect(res.getHeader("Set-Cookie")).toBeUndefined();
    },
  );

  it("does not issue a session when the initialized user is absent", async () => {
    mocks.findUser.mockResolvedValue(null);
    const { req, res } = request();

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(mocks.jwt).not.toHaveBeenCalled();
    expect(res.getHeader("Set-Cookie")).toBeUndefined();
  });
});
