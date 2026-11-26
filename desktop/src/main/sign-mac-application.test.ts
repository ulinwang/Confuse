import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { signMacApplication } from "../../scripts/sign-mac-application.mjs";

describe("signMacApplication", () => {
  it("ad-hoc signs and verifies the complete application bundle", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const spawnImpl = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    };

    await signMacApplication("arm64", {}, spawnImpl);

    expect(calls).toEqual([
      {
        command: "codesign",
        args: [
          "--force",
          "--deep",
          "--sign",
          "-",
          expect.stringMatching(/Confuse-darwin-arm64\/Confuse\.app$/),
        ],
      },
      {
        command: "codesign",
        args: [
          "--verify",
          "--deep",
          "--strict",
          expect.stringMatching(/Confuse-darwin-arm64\/Confuse\.app$/),
        ],
      },
    ]);
  });

  it("uses a configured Developer ID without putting credentials in arguments", async () => {
    const calls: string[][] = [];
    const spawnImpl = (_command: string, args: string[]) => {
      calls.push(args);
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0));
      return child;
    };

    await signMacApplication(
      "x64",
      {
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
        APPLE_ID_PASSWORD: "must-not-appear-in-arguments",
      },
      spawnImpl,
    );

    expect(calls[0]).toContain("Developer ID Application: Example");
    expect(calls[1]).toEqual([
      "--verify",
      "--deep",
      "--strict",
      expect.stringMatching(/Confuse-darwin-x64\/Confuse\.app$/),
    ]);
    expect(JSON.stringify(calls)).not.toContain("must-not-appear-in-arguments");
  });
});
