import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createDshPackageVersionPlugin } from "./dsh-package-version.mjs";
import { nodeEsmBanner } from "./node-esm-banner.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "confuse-smoke-build-"),
);

try {
  const entry = join(temporaryDirectory, "smoke-runtime.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("smoke-runtime.entry.mjs", import.meta.url)),
    ],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: nodeEsmBanner,
    },
    plugins: [
      await createDshPackageVersionPlugin(
        new URL("../package.json", import.meta.url),
      ),
    ],
    logLevel: "warning",
    outfile: entry,
  });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        CONFUSE_RESOURCE_DIR: join(desktopRoot, "resources"),
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Runtime smoke test failed (${signal ?? `exit ${code}`})`),
        );
    });
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
