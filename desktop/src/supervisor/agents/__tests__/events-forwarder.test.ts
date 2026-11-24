import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectAgents, normalizeAgentPayload } from "..";
import { renderForwarderScript } from "../forwarder";
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

describe("Langfuse event normalization", () => {
  it("correlates tool events and carries model usage with deterministic IDs", () => {
    const base = {
      session_id: "session-1",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      cwd: "/tmp/project",
    };
    const pre = normalizeAgentPayload(
      "kimi-code",
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_input: { command: "pwd" },
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    const post = normalizeAgentPayload(
      "kimi-code",
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_response: { output: "/tmp/project" },
      },
      new Date("2026-01-01T00:00:01Z"),
    );
    const preSpan = pre.find((event) => event.type === "span-create");
    const postSpan = post.find((event) => event.type === "span-create");
    expect(preSpan?.body.id).toBe(postSpan?.body.id);
    expect(preSpan?.body.parentObservationId).toBe(
      postSpan?.body.parentObservationId,
    );
    expect(postSpan?.body.endTime).toBeDefined();

    const stop = normalizeAgentPayload("kimi-code", {
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
      model: "kimi-for-coding",
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      last_assistant_message: "done",
    });
    const generation = stop.find((event) => event.type === "generation-create");
    expect(generation?.body).toMatchObject({
      model: "kimi-for-coding",
      usage: { input: 12, output: 5, total: 17, unit: "TOKENS" },
      output: "done",
    });
    expect(stop.map((event) => event.id)).toEqual(
      normalizeAgentPayload("kimi-code", {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        model: "kimi-for-coding",
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        last_assistant_message: "done",
      }).map((event) => event.id),
    );
  });

  it("normalizes native DSH session telemetry rather than treating it as OTLP logs", () => {
    const telemetry = {
      channel: "ledger",
      time: 1_700_000_000_000,
      severity: "info",
      attributes: {
        "session.id": "dsh-session",
        "session.format_version": 1,
        "event.seq": 4,
      },
      sourceEvent: {
        sessionId: "dsh-session",
        envelope: { seq: 4, type: "tool/result", turn: 2 },
      },
      body: { tool_call_id: "call-4", name: "Read", output: { text: "ok" } },
    };
    const batch = normalizeAgentPayload("deepseek-harness", telemetry);
    const span = batch.find((event) => event.type === "span-create");
    expect(span?.body.name).toBe("Read");
    expect(span?.body.metadata).toMatchObject({
      agent: "deepseek-harness",
      turnId: 2,
      formatVersion: 1,
    });
    const migrated = normalizeAgentPayload("deepseek-harness", {
      ...telemetry,
      attributes: { ...telemetry.attributes, "session.format_version": 2 },
    });
    expect(migrated.map((event) => event.id)).not.toEqual(
      batch.map((event) => event.id),
    );
  });
});

describe("local hook forwarding", () => {
  it("executes the installed script and forwards a synthetic hook to the daemon", async () => {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.writeHead(202);
          response.end();
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      server.listen(0, "127.0.0.1", async () => {
        try {
          const address = server.address() as AddressInfo;
          fixture.context.transport = {
            type: "http",
            url: `http://127.0.0.1:${address.port}/v1/agent-events`,
          };
          await installFakeCli(fixture, "kimi", "1.2.3");
          const [result] = await connectAgents(
            [selection("kimi-code")],
            fixture.context,
          );
          expect(result.state).toBe("connected");
          const scriptPath = join(
            fixture.home,
            ".kimi-code",
            "hooks",
            "confuse-forward.mjs",
          );
          expect(await readFile(scriptPath, "utf8")).toContain(
            "confuse-agent-hook",
          );
          const child = spawn(process.execPath, [scriptPath, "kimi-code"], {
            stdio: ["pipe", "ignore", "pipe"],
          });
          child.stdin.end(
            JSON.stringify({
              hook_event_name: "SessionStart",
              session_id: "s-1",
            }),
          );
          const exit = new Promise<number | null>((done) =>
            child.on("close", done),
          );
          expect(await exit).toBe(0);
          const envelope = await received;
          expect(envelope).toMatchObject({
            source: "confuse-agent-hook",
            agent: "kimi-code",
            payload: { hook_event_name: "SessionStart", session_id: "s-1" },
          });
        } catch (error) {
          reject(error);
        } finally {
          server.close();
        }
      });
    });
    await received;
  });

  it("rejects non-loopback and credential-bearing forwarding destinations", () => {
    for (const url of [
      "http://169.254.169.254/latest",
      "http://10.0.0.1/events",
      "http://user:pass@127.0.0.1/events",
      "https://127.0.0.1/events",
    ]) {
      expect(() => renderForwarderScript({ type: "http", url })).toThrow();
    }
  });
});
