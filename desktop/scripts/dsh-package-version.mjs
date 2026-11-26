import { readFile } from "node:fs/promises";

export async function createDshPackageVersionPlugin(packageJsonUrl) {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
  const version = packageJson.dependencies["@deepseek-ai/dsh-session"];
  return {
    name: "inline-dsh-package-version",
    setup(build) {
      build.onLoad({ filter: /dsh-(?:session|llm).*\.js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        if (!source.includes('("../package.json")')) return;
        return {
          contents: source.replace(
            'createRequire(import.meta.url)("../package.json")',
            `({ version: ${JSON.stringify(version)} })`,
          ),
          loader: "js",
        };
      });
    },
  };
}
