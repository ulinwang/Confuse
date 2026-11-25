import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectAgents,
  detectAgentConnectionState,
  disconnectAgents,
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

describe("Kimi Code and Claude Code configuration", () => {
  it("preserves Kimi TOML and credentials without exposing them in the preview", async () => {
    const home = join(fixture.home, "custom-kimi");
    await mkdir(home, { recursive: true });
    const configPath = join(home, "config.toml");
    const original = [
      'default_model = "kimi-for-coding"',
      "",
      "[providers.kimi]",
      'api_key = "do-not-expose-this-secret"',
      "",
      "[[hooks]]",
      'event = "Stop"',
      'command = "user-owned-hook"',
      "",
    ].join("\n");
    await writeFile(configPath, original);
    fixture.context.env.KIMI_CODE_HOME = home;
    await writeFile(
      join(home, "session_index.jsonl"),
      "private session body\n",
    );
    const selected = selection("kimi-code", home, true);

    const [before] = await scanAgents(fixture.context);
    expect(before).toMatchObject({
      installed: true,
      configPath,
      connectionState: "not-connected",
    });

    const [connected] = await connectAgents([selected], fixture.context);
    expect(connected.state).toBe("connected");
    expect(connected.importHistory).toBe(true);
    expect(JSON.stringify(connected.preview)).not.toContain(
      "do-not-expose-this-secret",
    );
    expect(
      connected.backups.filter((backup) => backup.backupPath),
    ).toHaveLength(1);

    const merged = await readFile(configPath, "utf8");
    expect(merged).toContain(original);
    expect(merged).toContain('command = "user-owned-hook"');
    expect(merged).toContain("confuse-forward.mjs");
    expect(merged).toContain('event = "Notification"');
    expect(await detectAgentConnectionState(selected, fixture.context)).toBe(
      "connected",
    );

    const [again] = await connectAgents([selected], fixture.context);
    expect(again.changed).toBe(false);
    expect(again.backups).toHaveLength(0);

    const [disconnected] = await disconnectAgents([selected], fixture.context);
    expect(disconnected.state).toBe("not-connected");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("merges Claude settings while retaining unrelated hooks and settings", async () => {
    await installFakeCli(fixture, "claude", "2.1.0");
    const home = join(fixture.home, "claude-custom");
    await mkdir(home, { recursive: true });
    fixture.context.env.CLAUDE_CONFIG_DIR = home;
    const configPath = join(home, "settings.json");
    const original = {
      model: "claude-sonnet-4-5",
      env: { PRIVATE_TOKEN: "not-in-preview" },
      hooks: {
        Stop: [
          { matcher: "*", hooks: [{ type: "command", command: "user-stop" }] },
        ],
      },
    };
    await writeFile(configPath, JSON.stringify(original, null, 2));
    const selected = selection("claude-code");

    const [connected] = await connectAgents([selected], fixture.context);
    expect(connected.state).toBe("connected");
    expect(JSON.stringify(connected.preview)).not.toContain("not-in-preview");
    const merged = JSON.parse(await readFile(configPath, "utf8"));
    expect(merged.model).toBe(original.model);
    expect(merged.env).toEqual(original.env);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("user-stop");
    expect(merged.hooks.SessionStart.at(-1).hooks[0].command).toContain(
      "confuse-forward.mjs",
    );

    await disconnectAgents([selected], fixture.context);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });
});
