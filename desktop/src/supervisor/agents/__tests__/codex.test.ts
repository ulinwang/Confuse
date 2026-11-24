import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatGptCodexAdapter } from "../chatgpt-codex";
import { connectAgents, detectAgentConnectionState, scanAgents } from "..";
import {
  createAgentFixture,
  installFakeApp,
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

describe("ChatGPT desktop Codex", () => {
  it("discovers the desktop bundle without a CLI and waits for exact-hook review", async () => {
    const classicApps = join(fixture.root, "classic-apps");
    await mkdir(classicApps, { recursive: true });
    await installFakeApp(
      fixture,
      "ChatGPT.app",
      "com.openai.chat",
      "1.0.0",
      classicApps,
    );
    fixture.context.applicationDirs.unshift(classicApps);
    const appPath = await installFakeApp(
      fixture,
      "ChatGPT.app",
      "com.openai.codex",
      "26.1023.50603",
    );
    const home = join(fixture.home, "codex-custom");
    await mkdir(home, { recursive: true });
    fixture.context.env.CODEX_HOME = home;
    const configPath = join(home, "hooks.json");
    await writeFile(
      configPath,
      JSON.stringify({
        description: "mine",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] },
      }),
    );
    const selected = selection("chatgpt-codex");

    const infos = await scanAgents(fixture.context);
    expect(infos.find((info) => info.kind === "chatgpt-codex")).toMatchObject({
      installed: true,
      applicationPath: appPath,
      version: "26.1023.50603",
    });

    const [connected] = await connectAgents([selected], fixture.context);
    expect(connected.state).toBe("waiting-for-review");
    expect(connected.message).toContain("Review hooks");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.description).toBe("mine");
    expect(config.hooks.Stop[0].hooks[0].command).toBe("mine");
    expect(config.hooks.SessionEnd.at(-1).hooks[0].async).toBeUndefined();
    expect(config.hooks.Stop.at(-1).hooks[0].async).toBe(true);
    expect(await detectAgentConnectionState(selected, fixture.context)).toBe(
      "waiting-for-review",
    );

    fixture.context.isCodexHookTrusted = async () => true;
    expect(
      await chatGptCodexAdapter.detectStatus(selected, fixture.context),
    ).toBe("connected");
  });

  it("does not mistake ChatGPT Classic for desktop Codex", async () => {
    await installFakeApp(fixture, "ChatGPT.app", "com.openai.chat", "1.0.0");
    const info = await chatGptCodexAdapter.discover(fixture.context);
    expect(info.installed).toBe(false);
    expect(info.liveCaptureSupported).toBe(false);
    expect(info.applicationPath).toBeUndefined();
  });
});
