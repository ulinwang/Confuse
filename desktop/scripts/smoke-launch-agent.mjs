import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import he from "he";

const { escape } = he;

const execFileAsync = promisify(execFile);
if (process.platform !== "darwin") {
  throw new Error("The launchd smoke test requires macOS");
}
if (!process.getuid) {
  throw new Error("The launchd smoke test requires a user session");
}

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "confuse-launchd-smoke-"));
const label = `com.confuse.smoke.${randomUUID()}`;
const architecture = process.arch === "arm64" ? "arm64" : "x64";
const application = join(
  desktopRoot,
  "out",
  `Confuse-darwin-${architecture}`,
  "Confuse.app",
);
const executable = join(application, "Contents", "MacOS", "Confuse");
const stdoutPath = join(root, "stdout.log");
const stderrPath = join(root, "stderr.log");
const plistPath = join(root, "agent.plist");
await writeFile(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${escape(executable)}</string>
    <string>--version</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${escape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escape(stderrPath)}</string>
</dict></plist>
`,
  { mode: 0o600 },
);

try {
  await execFileAsync("/bin/launchctl", [
    "bootstrap",
    `gui/${process.getuid()}`,
    plistPath,
  ]);
  let output = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    output = await readFile(stdoutPath, "utf8").catch(() => "");
    if (output.trim()) break;
    await delay(100);
  }
  if (!output.trim()) {
    const errors = await readFile(stderrPath, "utf8").catch(() => "");
    throw new Error(`The temporary application did not start: ${errors}`);
  }
  console.log(
    `Confuse launchd smoke passed: the packaged application executed with a temporary label (${output.trim()}).`,
  );
} finally {
  await execFileAsync("/bin/launchctl", [
    "bootout",
    `gui/${process.getuid()}/${label}`,
  ]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
