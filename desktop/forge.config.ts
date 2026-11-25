import { existsSync } from "node:fs";
import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
const appleId = process.env.APPLE_ID;
const appleIdPassword = process.env.APPLE_ID_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;
const appleCredentials =
  signingIdentity && appleId && appleIdPassword && appleTeamId
    ? { signingIdentity, appleId, appleIdPassword, appleTeamId }
    : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    name: "Confuse",
    executableName: "Confuse",
    appBundleId: "com.confuse.desktop",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Copyright © Confuse contributors",
    darwinDarkModeSupport: true,
    prune: false,
    asar: {
      unpack: "**/{dist,node_modules,resources}/**/*",
    },
    extraResource: existsSync(path.join(__dirname, "resources"))
      ? ["resources"]
      : [],
    ignore: [
      /^\/src(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/node_modules(?:\/|$)/,
    ],
    osxSign: appleCredentials
      ? {
          identity: appleCredentials.signingIdentity,
        }
      : undefined,
    osxNotarize: appleCredentials
      ? {
          appleId: appleCredentials.appleId,
          appleIdPassword: appleCredentials.appleIdPassword,
          teamId: appleCredentials.appleTeamId,
        }
      : undefined,
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      config: {
        title: "Confuse",
        format: "ULFO",
        overwrite: true,
      },
    },
  ],
};

export default config;
