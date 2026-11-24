import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDesktopStore, getUnreadCount } from "./desktopStore";

function desktopState(jobs: DesktopJob[] = []): DesktopState {
  return {
    version: 1,
    firstRunComplete: true,
    runtime: "ready",
    webUrl: "http://127.0.0.1:3000",
    jobs,
  };
}

function notification(id: string, readAt?: string): DesktopNotification {
  return {
    id,
    severity: "info",
    title: id,
    body: "Desktop activity",
    createdAt: "2026-01-01T00:00:00.000Z",
    readAt,
  };
}

describe("desktopStore", () => {
  it("merges live notifications and persists mark-all-read", async () => {
    let notifications = [
      notification("unread"),
      notification("read", "2026-01-01T00:00:00.000Z"),
    ];
    const listeners = new Map<string, (event: DesktopNotification) => void>();
    const invoke = vi.fn((channel: DesktopChannel, _request: unknown) => {
      if (channel === "desktop.get-state") {
        return Promise.resolve(desktopState());
      }
      if (channel === "notifications.list") {
        return Promise.resolve(notifications);
      }
      if (channel === "notifications.mark-read") {
        notifications = notifications.map((item) => ({
          ...item,
          readAt: item.readAt ?? "2026-01-02T00:00:00.000Z",
        }));
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`Unexpected channel: ${channel}`));
    });
    const bridge = {
      invoke,
      subscribe: vi.fn(
        (channel: string, listener: (event: DesktopNotification) => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        },
      ),
    } as unknown as ConfuseBridge;
    const store = createDesktopStore(() => bridge);
    const unsubscribe = store.subscribe(() => undefined);

    await waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(getUnreadCount(store.getSnapshot())).toBe(1);

    listeners.get("desktop.notification-created")?.(notification("new"));
    expect(getUnreadCount(store.getSnapshot())).toBe(2);

    await store.markAllRead();
    expect(invoke).toHaveBeenCalledWith("notifications.mark-read", {
      ids: ["new", "unread"],
    });
    expect(getUnreadCount(store.getSnapshot())).toBe(0);
    unsubscribe();
  });

  it.each(["connect" as const, "history-import" as const])(
    "retries a failed $kind task through jobs.retry",
    async (kind) => {
      const failedJob: DesktopJob = {
        id: "failed-job",
        kind,
        agentKind: "kimi-code",
        state: "failed",
        progress: 0.4,
        message: "Retry available",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const invoke = vi.fn((channel: DesktopChannel, _request: unknown) => {
        if (channel === "desktop.get-state") {
          return Promise.resolve(desktopState([failedJob]));
        }
        if (channel === "notifications.list") return Promise.resolve([]);
        if (channel === "jobs.retry") {
          return Promise.resolve({ jobId: "replacement-job" });
        }
        return Promise.reject(new Error(`Unexpected channel: ${channel}`));
      });
      const bridge = {
        invoke,
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ConfuseBridge;
      const store = createDesktopStore(() => bridge);
      const unsubscribe = store.subscribe(() => undefined);
      await waitFor(() => expect(store.getSnapshot().status).toBe("ready"));

      await store.retryJob(failedJob);

      expect(invoke).toHaveBeenCalledWith("jobs.retry", { id: failedJob.id });
      expect(store.getSnapshot().pendingJobIds).toEqual({});
      expect(store.getSnapshot().actionError).toBeNull();
      unsubscribe();
    },
  );

  it("subscribes before loading and merges events that arrive during the load", async () => {
    let resolveState!: (state: DesktopState) => void;
    let resolveNotifications!: (notifications: DesktopNotification[]) => void;
    const stateResponse = new Promise<DesktopState>((resolve) => {
      resolveState = resolve;
    });
    const notificationsResponse = new Promise<DesktopNotification[]>(
      (resolve) => {
        resolveNotifications = resolve;
      },
    );
    const listeners = new Map<
      string,
      (event: DesktopState | DesktopJob | DesktopNotification) => void
    >();
    const bridge = {
      invoke: vi.fn((channel: DesktopChannel) => {
        if (channel === "desktop.get-state") return stateResponse;
        if (channel === "notifications.list") return notificationsResponse;
        return Promise.reject(new Error(`Unexpected channel: ${channel}`));
      }),
      subscribe: vi.fn(
        (
          channel: string,
          listener: (
            event: DesktopState | DesktopJob | DesktopNotification,
          ) => void,
        ) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        },
      ),
    } as unknown as ConfuseBridge;
    const store = createDesktopStore(() => bridge);

    const unsubscribe = store.subscribe(() => undefined);
    expect(bridge.subscribe).toHaveBeenCalledTimes(3);

    const liveJob: DesktopJob = {
      id: "live-job",
      kind: "connect",
      agentKind: "kimi-code",
      state: "running",
      progress: 0.25,
      message: "Connecting",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    listeners.get("desktop.job-changed")?.(liveJob);
    listeners.get("desktop.notification-created")?.(notification("live"));
    resolveState(desktopState());
    resolveNotifications([]);

    await waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(store.getSnapshot().state?.jobs).toEqual([liveJob]);
    expect(store.getSnapshot().notifications.map((item) => item.id)).toEqual([
      "live",
    ]);
    unsubscribe();
  });
});
