import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
  const child = spawn(command, args, {
    cwd: desktopRoot,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const images = await run(process.execPath, ["scripts/build-images.mjs"]);
if (images.code !== 0) {
  process.exit(images.code ?? 1);
}

const build = await run(process.execPath, ["scripts/build.mjs"]);
if (build.code !== 0) {
  process.exit(build.code ?? 1);
}

const electron = process.platform === "win32" ? "electron.cmd" : "electron";
const child = spawn(electron, ["."], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    NODE_ENV: "development",
    CONFUSE_WEB_IMAGE: process.env.CONFUSE_WEB_IMAGE ?? "confuse-web:local",
    CONFUSE_WORKER_IMAGE:
      process.env.CONFUSE_WORKER_IMAGE ?? "confuse-worker:local",
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
