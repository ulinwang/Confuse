import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopNotification } from "../shared/contracts";
import type { AgentRuntimeAdapter } from "./adapters";
import { SupervisorEvents } from "./events";
import { JobManager } from "./jobs";
import { SupervisorRouter } from "./router";
import { DesktopStore } from "./store";

describe("JobManager", () => {
  let store: DesktopStore;
  let events: SupervisorEvents;
  let jobs: JobManager;

  beforeEach(() => {
    store = new DesktopStore(":memory:");
    events = new SupervisorEvents();
    jobs = new JobManager(store, events);
    jobs.start();
  });

  afterEach(async () => {
    await jobs.stop();
    store.close();
  });

  it.each([
    {
      state: "succeeded" as const,
      severity: "success" as const,
      title: "Runtime task completed",
    },
    {
      state: "partially-succeeded" as const,
      severity: "warning" as const,
      title: "Runtime task partially completed",
    },
    {
      state: "waiting-for-review" as const,
      severity: "info" as const,
      title: "Runtime task needs review",
    },
    {
      state: "failed" as const,
      severity: "error" as const,
      title: "Runtime task failed",
    },
  ])("persists and emits a notification for $state jobs", async (testCase) => {
    const emitted: DesktopNotification[] = [];
    events.subscribe((event) => {
      if (event.event === "desktop.notification-created") {
        emitted.push(event.payload as DesktopNotification);
      }
    });
    jobs.register("runtime", async () => {
      if (testCase.state === "failed") throw new Error("Synthetic failure");
      return { state: testCase.state, message: "Synthetic result" };
    });

    const job = jobs.enqueue({ kind: "runtime" });
    await jobs.drain();

    expect(store.getJob(job.id).job.state).toBe(testCase.state);
    const expectedBody =
      testCase.state === "failed" ? "Synthetic failure" : "Synthetic result";
    expect(store.listNotifications()).toEqual([
      expect.objectContaining({
        jobId: job.id,
        severity: testCase.severity,
        title: testCase.title,
        body: expectedBody,
        actionRoute: "/?notificationCenter=open",
      }),
    ]);
    expect(emitted).toEqual(store.listNotifications());
  });

  it("retries the persisted kind and payload and summarizes Agent and history results", async () => {
    const router = new SupervisorRouter(store, jobs, events, async () => {});
    const connect = vi.fn(async () => ({ message: "Connected" }));
    const importHistory = vi.fn(async () => ({
      state: "partially-succeeded" as const,
      message: "Imported 2 of 3 sessions",
    }));
    const adapter: AgentRuntimeAdapter = {
      scan: async () => [],
      connect,
      previewHistory: async () => [],
      importHistory,
    };
    router.setAgentAdapter(adapter);
    const selection = {
      kind: "kimi-code" as const,
      configPath: "/tmp/kimi/config.toml",
      importHistory: true,
    };

    const started = (await router.handle({
      id: "start",
      channel: "agents.connect",
      payload: { selections: [selection] },
    })) as { jobIds: string[] };
    await jobs.drain();

    expect(store.listNotifications()[0].body).toBe(
      "Agent connection: Connected; History import: Imported 2 of 3 sessions",
    );
    const retried = (await router.handle({
      id: "retry",
      channel: "jobs.retry",
      payload: { id: started.jobIds[0] },
    })) as { jobId: string };
    await jobs.drain();

    expect(retried.jobId).not.toBe(started.jobIds[0]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0][0]).toEqual(selection);
    expect(connect.mock.calls[1][0]).toEqual(selection);
    expect(importHistory).toHaveBeenCalledTimes(2);
    expect(store.getJob(retried.jobId).job).toMatchObject({
      kind: "connect",
      agentKind: "kimi-code",
      state: "partially-succeeded",
    });
  });
});
