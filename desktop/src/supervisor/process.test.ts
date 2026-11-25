import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { NodeProcessRunner, ProcessRunError } from "./process";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  child.stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });
  child.kill = vi.fn();
  return child;
}

describe("NodeProcessRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it.each(["timeout", "abort"] as const)(
    "escalates a %s from SIGTERM to SIGKILL and rejects",
    async (reason) => {
      vi.useFakeTimers();
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const controller = new AbortController();
      const running = new NodeProcessRunner().run("/usr/bin/example", [], {
        timeoutMs: 10,
        signal: controller.signal,
      });
      const rejection = running.catch((error: unknown) => error);

      if (reason === "abort") controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(reason === "timeout" ? 999 : 989);
      expect(child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      const error = await rejection;
      expect(error).toBeInstanceOf(ProcessRunError);
      expect(error).toMatchObject({
        exitCode: null,
        signal: "SIGKILL",
        message:
          reason === "timeout"
            ? "/usr/bin/example timed out"
            : "/usr/bin/example was cancelled",
      });
    },
  );
});
