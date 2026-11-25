import { spawn } from "node:child_process";

const version = process.env.CONFUSE_RELEASE_VERSION;
if (
  !version ||
  !/^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/.test(version)
) {
  throw new Error(`Invalid release version: ${version ?? "unset"}`);
}

function createManifest(name) {
  return new Promise((resolve, reject) => {
    const repository = `ghcr.io/ulinwang/confuse-${name}`;
    const child = spawn(
      "docker",
      [
        "buildx",
        "imagetools",
        "create",
        "--tag",
        `${repository}:${version}`,
        `${repository}:${version}-amd64`,
        `${repository}:${version}-arm64`,
      ],
      { env: process.env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Failed to create ${repository}:${version} manifest (${signal ?? `exit ${code}`})`,
          ),
        );
      }
    });
  });
}

for (const name of ["web", "worker"]) {
  await createManifest(name);
}
