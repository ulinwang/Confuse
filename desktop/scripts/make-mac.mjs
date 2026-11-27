import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signMacApplication } from "./sign-mac-application.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
await rm(path.join(desktopRoot, "out", "make"), {
  recursive: true,
  force: true,
});

function forge(command, arch, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "electron-forge",
      [command, "--platform=darwin", `--arch=${arch}`, ...args],
      {
        cwd: desktopRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Failed to build macOS ${arch} (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
        ),
      );
    });
  });
}

for (const arch of ["arm64", "x64"]) {
  await forge("package", arch);
  await signMacApplication(arch);
  await forge("make", arch, "--skip-package");
}
