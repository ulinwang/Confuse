import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectAgents,
  disconnectAgents,
  previewAgentConnection,
  scanAgents,
} from "..";
import {
  createAgentFixture,
  installFakeCli,
  selection,
  type AgentFixture,
} from "./fixtures";

let fixture: AgentFixture;

beforeEach(async () => {
  fixture = await createAgentFixture();
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("DeepSeek Harness capability gate", () => {
  it("installs a native live telemetry backend on a supported Developer Preview", async () => {
    await installFakeCli(fixture, "dsh", "0.2.1-rc.5");
    const home = join(fixture.home, ".dsh");
    await mkdir(home, { recursive: true });
    const patchPath = join(home, "cordis.patch.yml");
    await writeFile(patchPath, "- id: user-owned\n  disabled: false\n");
    const selected = selection("deepseek-harness");

    const [connected] = await connectAgents([selected], fixture.context);
    expect(connected.state).toBe("connected");
    const patch = await readFile(patchPath, "utf8");
    expect(patch).toContain("- id: user-owned");
    expect(patch).toContain("confuse-session-telemetry");
    const plugin = await readFile(
      join(home, "confuse-plugin", "index.js"),
      "utf8",
    );
    expect(plugin).toContain("SessionTelemetryBackend");
    expect(plugin).toContain("includeHistory: false");
    expect(plugin).not.toContain("OTLP");

    await disconnectAgents([selected], fixture.context);
    expect(await readFile(patchPath, "utf8")).toBe(
      "- id: user-owned\n  disabled: false\n",
    );
  });

  it("does not read or change configuration for an unsupported version", async () => {
    await installFakeCli(fixture, "dsh", "0.3.0");
    const home = join(fixture.home, ".dsh");
    await mkdir(home, { recursive: true });
    const patchPath = join(home, "cordis.patch.yml");
    const original = "# unsupported versions remain byte-for-byte unchanged\n";
    await writeFile(patchPath, original);
    const selected = selection("deepseek-harness");

    const [info] = (await scanAgents(fixture.context)).filter(
      (candidate) => candidate.kind === "deepseek-harness",
    );
    expect(info).toMatchObject({
      connectionState: "unsupported",
      liveCaptureSupported: false,
    });
    expect(
      await previewAgentConnection(selected, fixture.context),
    ).toMatchObject({
      supported: false,
      changed: false,
      files: [],
    });
    const [result] = await connectAgents([selected], fixture.context);
    expect(result).toMatchObject({
      state: "unsupported",
      changed: false,
      backups: [],
    });
    expect(await readFile(patchPath, "utf8")).toBe(original);
  });
});
