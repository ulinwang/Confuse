import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const outputRoot = path.resolve(
  process.argv[2] ?? path.join(desktopRoot, "out"),
);

async function findDmgs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findDmgs(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
      files.push(entryPath);
    }
  }
  return files;
}

const expectedNames = ["arm64", "x64"].map(
  (arch) => `${packageJson.productName}-${packageJson.version}-${arch}.dmg`,
);
const dmgs = await findDmgs(outputRoot);
const actualNames = dmgs.map((file) => path.basename(file)).sort();
const expectedSorted = [...expectedNames].sort();
if (
  dmgs.length !== expectedNames.length ||
  actualNames.some((name, index) => name !== expectedSorted[index])
) {
  throw new Error(
    `Expected exactly ${expectedNames.join(" and ")} in ${outputRoot}; found ${actualNames.join(", ") || "no DMGs"}`,
  );
}

for (const dmg of dmgs) {
  if ((await stat(dmg)).size === 0) {
    throw new Error(`DMG is empty: ${dmg}`);
  }
}

console.log(`Verified ARM64 and x64 DMGs: ${actualNames.join(", ")}`);
