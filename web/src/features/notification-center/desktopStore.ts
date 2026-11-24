import { useSyncExternalStore } from "react";
import { getConfuseBridge } from "./bridge";

type DesktopStoreSnapshot = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  state: DesktopState | null;
  notifications: DesktopNotification[];
  error: string | null;
  actionError: string | null;
  isMarkingAllRead: boolean;
  pendingJobIds: Readonly<Record<string, true>>;
};

const initialSnapshot: DesktopStoreSnapshot = {
  status: "idle",
  state: null,
  notifications: [],
  error: null,
  actionError: null,
  isMarkingAllRead: false,
  pendingJobIds: {},
};

const serverSnapshot = initialSnapshot;

type DesktopEvent =
  | { channel: "desktop.state-changed"; value: DesktopState }
  | { channel: "desktop.job-changed"; value: DesktopJob }
  | { channel: "desktop.notification-created"; value: DesktopNotification };

function applyEvent(
  current: DesktopStoreSnapshot,
  event: DesktopEvent,
): DesktopStoreSnapshot {
  switch (event.channel) {
    case "desktop.state-changed":
      return { ...current, status: "ready", state: event.value, error: null };
    case "desktop.job-changed": {
      if (!current.state) return current;
      const existingIndex = current.state.jobs.findIndex(
        (candidate) => candidate.id === event.value.id,
      );
      const jobs = [...current.state.jobs];
      if (existingIndex === -1) {
        jobs.unshift(event.value);
      } else {
        jobs[existingIndex] = event.value;
      }
      return { ...current, state: { ...current.state, jobs } };
    }
    case "desktop.notification-created":
      if (
        current.notifications.some(
          (candidate) => candidate.id === event.value.id,
        )
      ) {
        return current;
      }
      return {
        ...current,
        notifications: [event.value, ...current.notifications],
      };
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function createDesktopStore(
  getBridge: () => ConfuseBridge | null = getConfuseBridge,
) {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot;
  let generation = 0;
  let loadRequest = 0;
  let running = false;
  let unsubscribeFromBridge: Array<() => void> = [];
  const activeLoadEvents = new Set<DesktopEvent[]>();

  function emit(next: DesktopStoreSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function patch(next: Partial<DesktopStoreSnapshot>) {
    emit({ ...snapshot, ...next });
  }

  function publish(event: DesktopEvent) {
    for (const events of activeLoadEvents) events.push(event);
    emit(applyEvent(snapshot, event));
  }

  async function load(requestGeneration: number, showLoading: boolean) {
    const request = ++loadRequest;
    const events: DesktopEvent[] = [];
    activeLoadEvents.add(events);
    if (showLoading) patch({ status: "loading", error: null });
    try {
      const bridge = getBridge();
      if (!bridge) {
        if (requestGeneration === generation && request === loadRequest) {
          patch({ status: "unavailable", error: null });
        }
        return;
      }

      const [state, notifications] = await Promise.all([
        bridge.invoke("desktop.get-state", undefined),
        bridge.invoke("notifications.list", undefined),
      ]);
      if (requestGeneration !== generation || request !== loadRequest) return;
      let next: DesktopStoreSnapshot = {
        ...snapshot,
        status: "ready",
        state,
        notifications,
        error: null,
      };
      for (const event of events) next = applyEvent(next, event);
      emit(next);
    } catch (error) {
      if (requestGeneration !== generation || request !== loadRequest) return;
      patch({
        status: "error",
        error: errorMessage(error, "Could not load desktop activity."),
      });
    } finally {
      activeLoadEvents.delete(events);
    }
  }

  function start() {
    if (running) return;
    running = true;
    const requestGeneration = ++generation;
    const bridge = getBridge();
    if (!bridge) {
      patch({ status: "unavailable", error: null });
      return;
    }

    unsubscribeFromBridge = [
      bridge.subscribe("desktop.state-changed", (state) => {
        publish({ channel: "desktop.state-changed", value: state });
      }),
      bridge.subscribe("desktop.job-changed", (job) => {
        publish({ channel: "desktop.job-changed", value: job });
      }),
      bridge.subscribe("desktop.notification-created", (notification) => {
        publish({
          channel: "desktop.notification-created",
          value: notification,
        });
      }),
    ];
    load(requestGeneration, true);
  }

  function stop() {
    running = false;
    generation += 1;
    loadRequest += 1;
    activeLoadEvents.clear();
    for (const unsubscribe of unsubscribeFromBridge) unsubscribe();
    unsubscribeFromBridge = [];
  }

  async function markAllRead() {
    const bridge = getBridge();
    const ids = snapshot.notifications
      .filter((notification) => !notification.readAt)
      .map((notification) => notification.id);
    if (!bridge || ids.length === 0 || snapshot.isMarkingAllRead) return;

    patch({ isMarkingAllRead: true, actionError: null });
    try {
      await bridge.invoke("notifications.mark-read", { ids });
      await load(generation, false);
      patch({ isMarkingAllRead: false });
    } catch (error) {
      patch({
        isMarkingAllRead: false,
        actionError: errorMessage(
          error,
          "Could not mark notifications as read.",
        ),
      });
    }
  }

  async function retryJob(job: DesktopJob) {
    const bridge = getBridge();
    if (!bridge || snapshot.pendingJobIds[job.id]) return;

    patch({
      pendingJobIds: { ...snapshot.pendingJobIds, [job.id]: true },
      actionError: null,
    });
    try {
      await bridge.invoke("jobs.retry", { id: job.id });
      await load(generation, false);
      const { [job.id]: _pending, ...pendingJobIds } = snapshot.pendingJobIds;
      patch({ pendingJobIds });
    } catch (error) {
      const { [job.id]: _pending, ...pendingJobIds } = snapshot.pendingJobIds;
      patch({
        pendingJobIds,
        actionError: errorMessage(error, "Could not retry this task."),
      });
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    refresh: () => load(generation, false),
    markAllRead,
    retryJob,
  };
}

export const desktopStore = createDesktopStore();

export function useDesktopStoreSnapshot() {
  return useSyncExternalStore(
    desktopStore.subscribe,
    desktopStore.getSnapshot,
    desktopStore.getServerSnapshot,
  );
}

const getFirstRunComplete = () =>
  desktopStore.getSnapshot().state?.firstRunComplete ?? null;
const getServerFirstRunComplete = () => null;

export function useDesktopFirstRunComplete() {
  return useSyncExternalStore(
    desktopStore.subscribe,
    getFirstRunComplete,
    getServerFirstRunComplete,
  );
}

export function getUnreadCount(snapshot: DesktopStoreSnapshot) {
  return snapshot.notifications.filter((notification) => !notification.readAt)
    .length;
}
