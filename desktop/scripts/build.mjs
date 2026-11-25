import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
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
  const desktopPackage = JSON.parse(
    await readFile(path.join(desktopRoot, "package.json"), "utf8"),
  );
  const dshVersion = desktopPackage.dependencies["@deepseek-ai/dsh-session"];
  await build({
    ...common,
    entryPoints: [supervisorEntry],
    format: "esm",
    plugins: [
      {
        name: "inline-dsh-package-version",
        setup(build) {
          build.onLoad(
            { filter: /dsh-(?:session|llm).*\.js$/ },
            async (args) => {
              const source = await readFile(args.path, "utf8");
              if (!source.includes('("../package.json")')) return;
              return {
                contents: source.replace(
                  'createRequire(import.meta.url)("../package.json")',
                  `({ version: ${JSON.stringify(dshVersion)} })`,
                ),
                loader: "js",
              };
            },
          );
        },
      },
    ],
    banner: {
      js: "import { createRequire as __confuseCreateRequire } from 'node:module'; const require = __confuseCreateRequire(import.meta.url);",
    },
    outfile: path.join(dist, "supervisor/index.mjs"),
  });
}
