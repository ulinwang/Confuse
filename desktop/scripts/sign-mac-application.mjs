import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));

function run(args, arch, env, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("codesign", args, {
      cwd: desktopRoot,
      env,
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
          `codesign failed for macOS ${arch} (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
        ),
      );
    });
  });
}

export async function signMacApplication(
  arch,
  env = process.env,
  spawnImpl = spawn,
) {
  const application = path.join(
    desktopRoot,
    "out",
    `Confuse-darwin-${arch}`,
    "Confuse.app",
  );
  const identity = env.APPLE_SIGNING_IDENTITY || "-";
  await run(
    ["--force", "--deep", "--sign", identity, application],
    arch,
    env,
    spawnImpl,
  );
  await run(
    ["--verify", "--deep", "--strict", application],
    arch,
    env,
    spawnImpl,
  );
}
