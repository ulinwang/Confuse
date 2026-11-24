import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitWrites } from "../filesystem";
import { createAgentFixture, type AgentFixture } from "./fixtures";

let fixture: AgentFixture;

beforeEach(async () => {
  fixture = await createAgentFixture();
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

describe("atomic configuration commits", () => {
  it("refuses a stale preview before modifying any file", async () => {
    const directory = join(fixture.home, "config");
    await mkdir(directory, { recursive: true });
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    await writeFile(first, "original-first");
    await writeFile(second, "concurrent-change");

    await expect(
      commitWrites(
        [
          {
            path: first,
            before: "original-first",
            after: "new-first",
            preview: "+ new-first",
          },
          {
            path: second,
            before: "original-second",
            after: "new-second",
            preview: "+ new-second",
          },
        ],
        new Date(),
      ),
    ).rejects.toThrow("changed after preview");
    expect(await readFile(first, "utf8")).toBe("original-first");
    expect(await readFile(second, "utf8")).toBe("concurrent-change");
  });

  it("backs up an existing file before atomically replacing it", async () => {
    const path = join(fixture.home, "settings.json");
    await writeFile(path, "original");
    const [backup] = await commitWrites(
      [{ path, before: "original", after: "updated", preview: "+ updated" }],
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(await readFile(path, "utf8")).toBe("updated");
    expect(backup.backupPath).toBeDefined();
    expect(await readFile(backup.backupPath!, "utf8")).toBe("original");
  });
});
