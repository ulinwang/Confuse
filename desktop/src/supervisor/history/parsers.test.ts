import { describe, expect, it } from "vitest";
import { parseDshHistoryEvent, parseJsonlHistoryEvent } from "./parsers.js";

const context = {
  sourceId: "source",
  sessionId: "fallback-session",
  workspaceId: "workspace",
  rolloutId: "rollout",
  transcriptId: "transcript",
};

describe("history source identities", () => {
  it("uses workspace/session/event for Kimi", () => {
    const event = parseJsonlHistoryEvent(
      "kimi-code",
      JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        event_id: "event-1",
        message: { model: "kimi", content: " synthetic" },
      }),
      context,
    );
    expect(event).toMatchObject({
      sessionId: "session-1",
      dedupKey: '["workspace","session-1","event-1"]',
      model: "kimi",
    });
  });

  it("uses thread/rollout/turn/item for Codex", () => {
    const event = parseJsonlHistoryEvent(
      "chatgpt-codex",
      JSON.stringify({
        type: "response_item",
        payload: {
          thread_id: "thread-1",
          turn_id: "turn-1",
          item: { type: "function_call", id: "item-1", name: "synthetic_tool" },
        },
      }),
      context,
    );
    expect(event).toMatchObject({
      sessionId: "thread-1",
      dedupKey: '["thread-1","rollout","turn-1","item-1"]',
      type: "tool",
    });
  });

  it("uses session/transcript/UUID for Claude and format/seq for DSH", () => {
    const claude = parseJsonlHistoryEvent(
      "claude-code",
      JSON.stringify({
        type: "user",
        sessionId: "session-2",
        uuid: "entry-1",
        message: {},
      }),
      context,
    );
    expect(claude?.dedupKey).toBe('["session-2","transcript","entry-1"]');

    const v1 = parseDshHistoryEvent({
      sessionId: "dsh-session",
      formatVersion: "v1",
      seq: 9,
      type: "message",
      payload: { synthetic: true },
    });
    const v2 = parseDshHistoryEvent({
      sessionId: "dsh-session",
      formatVersion: "v2",
      seq: 9,
      type: "message",
      payload: { synthetic: true },
    });
    expect(v1.dedupKey).not.toBe(v2.dedupKey);
  });

  it("falls back to a deterministic content ID and skips unknown records", () => {
    const raw = JSON.stringify({
      type: "user",
      sessionId: "session",
      message: { content: "same" },
    });
    const first = parseJsonlHistoryEvent("claude-code", raw, context);
    const second = parseJsonlHistoryEvent("claude-code", raw, context);
    expect(first?.dedupKey).toBe(second?.dedupKey);
    expect(
      parseJsonlHistoryEvent("claude-code", '{"type":"mystery"}', context),
    ).toBeUndefined();
  });
});
