import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function options(argv) {
  let push = false;
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--push") {
      push = true;
    } else if (argument === "--tag") {
      tag = argv[index + 1];
      if (!tag) throw new Error("--tag requires a value");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (tag && !push) throw new Error("--tag requires --push");
  tag ??= packageJson.version;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    throw new Error(`Invalid image tag: ${tag}`);
  }
  return { push, tag };
}

function buildImage(dockerfile, image, push) {
  return new Promise((resolve, reject) => {
    const memoryArgs =
      dockerfile === "web/Dockerfile"
        ? ["--build-arg", "NODE_BUILD_OPTIONS=--max-old-space-size=3072"]
        : [];
    const args = push
      ? [
          "buildx",
          "build",
          "--platform",
          "linux/amd64,linux/arm64",
          "--file",
          dockerfile,
          "--tag",
          image,
          "--push",
          ...memoryArgs,
          ".",
        ]
      : ["build", "--file", dockerfile, "--tag", image, ...memoryArgs, "."];
    const child = spawn("docker", args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Failed to build ${image} (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
        ),
      );
    });
  });
}

const { push, tag } = options(process.argv.slice(2));
for (const [dockerfile, name] of [
  ["web/Dockerfile", "web"],
  ["worker/Dockerfile", "worker"],
]) {
  const image = push
    ? `ghcr.io/ulinwang/confuse-${name}:${tag}`
    : `confuse-${name}:local`;
  await buildImage(dockerfile, image, push);
}
