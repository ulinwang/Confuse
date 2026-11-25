import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function parseOptions(argv) {
  let push = false;
  let tag;
  let platform;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--push") {
      push = true;
    } else if (argument === "--tag") {
      tag = argv[index + 1];
      if (!tag) throw new Error("--tag requires a value");
      index += 1;
    } else if (argument === "--platform") {
      platform = argv[index + 1];
      if (!platform) throw new Error("--platform requires a value");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (tag && !push) throw new Error("--tag requires --push");
  if (push && !tag) throw new Error("--push requires --tag");
  if (push && !platform) throw new Error("--push requires --platform");
  if (platform && !["linux/amd64", "linux/arm64"].includes(platform)) {
    throw new Error(`Unsupported image platform: ${platform}`);
  }
  if (tag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    throw new Error(`Invalid image tag: ${tag}`);
  }
  return { push, tag, platform };
}

function buildImage(dockerfile, image, { push, platform }) {
  return new Promise((resolve, reject) => {
    const memoryArgs =
      dockerfile === "web/Dockerfile"
        ? [
            "--build-arg",
            "NODE_BUILD_OPTIONS=--max-old-space-size=3072",
            "--build-arg",
            "CONFUSE_BUILD_WORKERS=1",
          ]
        : [];
    const platformArgs = platform ? ["--platform", platform] : [];
    const args = push
      ? [
          "buildx",
          "build",
          ...platformArgs,
          "--file",
          dockerfile,
          "--tag",
          image,
          "--push",
          ...memoryArgs,
          ".",
        ]
      : [
          "build",
          ...platformArgs,
          "--file",
          dockerfile,
          "--tag",
          image,
          ...memoryArgs,
          ".",
        ];
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

const { push, tag, platform } = parseOptions(process.argv.slice(2));
for (const [dockerfile, name] of [
  ["web/Dockerfile", "web"],
  ["worker/Dockerfile", "worker"],
]) {
  const image = push
    ? `ghcr.io/ulinwang/confuse-${name}:${tag}`
    : `confuse-${name}:local`;
  await buildImage(dockerfile, image, { push, platform });
}
