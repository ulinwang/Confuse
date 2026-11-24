import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxWorker } from "./outbox";
import { DesktopStore } from "./store";

describe("desktop persistence", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), "confuse-store-"));
    directories.push(directory);
    return join(directory, "state.sqlite");
  }

  it("persists notification read state and recovers interrupted jobs", () => {
    const path = databasePath();
    const store = new DesktopStore(path);
    store.initializeState("http://127.0.0.1:3000");
    const notification = store.createNotification({
      severity: "info",
      title: "Ready",
      body: "Runtime ready",
    });
    const job = store.createJob({ kind: "runtime" });
    store.updateJob(job.id, { state: "running", progress: 0.4 });
    store.markNotificationsRead([notification.id]);
    store.close();

    const reopened = new DesktopStore(path);
    expect(reopened.listNotifications()[0].readAt).toBeDefined();
    expect(reopened.recoverQueuedJobs()[0]).toMatchObject({
      id: job.id,
      state: "queued",
      progress: 0.4,
    });
    reopened.close();
  });

  it("keeps failed outbox deliveries for a later retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const path = databasePath();
    let store = new DesktopStore(path);
    const record = store.enqueueOutbox("trace", { id: "synthetic" });
    let attempts = 0;
    const dispatch = async () => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary network failure");
    };
    let worker = new OutboxWorker(store, 60_000);
    worker.setDispatcher(dispatch);
    await worker.flush();
    expect(store.dueOutbox()).toHaveLength(0);
    store.close();

    store = new DesktopStore(path);
    worker = new OutboxWorker(store, 60_000);
    worker.setDispatcher(dispatch);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await worker.flush();
    expect(attempts).toBe(2);
    expect(store.dueOutbox().map((item) => item.id)).not.toContain(record.id);
    await worker.stop();
    store.close();
  });
});
