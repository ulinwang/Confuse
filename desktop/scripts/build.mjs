import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(desktopRoot, "dist");
await rm(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  tsconfig: path.join(desktopRoot, "tsconfig.build.json"),
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [path.join(desktopRoot, "src/main/index.ts")],
  external: ["electron"],
  format: "cjs",
  outfile: path.join(dist, "main/index.js"),
});
await build({
  ...common,
  entryPoints: [path.join(desktopRoot, "src/preload/index.ts")],
  external: ["electron"],
  format: "cjs",
  outfile: path.join(dist, "preload/index.js"),
});

const supervisorEntry = path.join(desktopRoot, "src/supervisor/index.ts");
if (existsSync(supervisorEntry)) {
  await build({
    ...common,
    entryPoints: [supervisorEntry],
    format: "esm",
    banner: {
      js: "import { createRequire as __confuseCreateRequire } from 'node:module'; const require = __confuseCreateRequire(import.meta.url);",
    },
    outfile: path.join(dist, "supervisor/index.mjs"),
  });
}
