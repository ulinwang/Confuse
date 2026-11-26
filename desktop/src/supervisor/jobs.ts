import type { AgentKind, DesktopJob, JobState } from "../shared/contracts";
import type { AgentJobContext, AgentJobResult } from "./adapters";
import type { SupervisorEvents } from "./events";
import { DesktopStore } from "./store";

export interface JobHandler {
  (payload: unknown, context: AgentJobContext): Promise<AgentJobResult | void>;
}

export class JobManager {
  private readonly handlers = new Map<DesktopJob["kind"], JobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private pumping = false;
  private stopped = false;

  constructor(
    private readonly store: DesktopStore,
    private readonly events: SupervisorEvents,
  ) {}

  register(kind: DesktopJob["kind"], handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  start(): void {
    this.stopped = false;
    for (const job of this.store.recoverQueuedJobs()) {
      this.events.emit("desktop.job-changed", job);
    }
    void this.pump();
  }

  enqueue(input: {
    kind: DesktopJob["kind"];
    agentKind?: AgentKind;
    payload?: unknown;
    message?: string;
  }): DesktopJob {
    if (this.stopped) throw new Error("Supervisor is stopping");
    const job = this.store.createJob(input);
    this.events.emit("desktop.job-changed", job);
    void this.pump();
    return job;
  }

  cancel(id: string): DesktopJob {
    const current = this.store.getJob(id).job;
    if (current.state !== "queued" && current.state !== "running")
      return current;
    const job = this.store.cancelJob(id)!;
    this.controllers.get(id)?.abort();
    this.events.emit("desktop.job-changed", job);
    return job;
  }

  retry(id: string): DesktopJob {
    const record = this.store.getJob(id);
    if (
      record.job.state !== "failed" &&
      record.job.state !== "cancelled" &&
      record.job.state !== "partially-succeeded" &&
      record.job.state !== "waiting-for-review"
    ) {
      throw new Error(
        "Only failed, cancelled, partially completed, or waiting jobs can be retried",
      );
    }
    const job = this.enqueue({
      kind: record.job.kind,
      agentKind: record.job.agentKind,
      payload: record.payload,
    });
    if (record.job.state === "waiting-for-review") {
      const superseded = this.store.updateJob(record.job.id, {
        state: "cancelled",
        message: `Retry queued as ${job.id}`,
      });
      this.events.emit("desktop.job-changed", superseded);
    }
    return job;
  }

  async drain(): Promise<void> {
    while (this.pumping || this.controllers.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.drain();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        const record = this.store.claimNextJob([...this.handlers.keys()]);
        if (!record) break;
        await this.run(record.job, record.payload);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: DesktopJob, payload: unknown): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) return;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const running = this.store.updateJob(job.id, { message: "Running" });
    this.events.emit("desktop.job-changed", running);
    const context: AgentJobContext = {
      signal: controller.signal,
      report: (progress, message) => {
        if (controller.signal.aborted) return;
        const changed = this.store.updateJob(job.id, { progress, message });
        this.events.emit("desktop.job-changed", changed);
      },
    };
    try {
      const result = await handler(payload, context);
      if (
        controller.signal.aborted ||
        this.store.getJob(job.id).job.state === "cancelled"
      )
        return;
      const state: JobState = result?.state ?? "succeeded";
      const changed = this.store.updateJob(job.id, {
        state,
        progress:
          state === "succeeded" ? 1 : this.store.getJob(job.id).job.progress,
        message: result?.message ?? "Completed",
      });
      this.events.emit("desktop.job-changed", changed);
      this.notifyTerminal(changed);
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.store.getJob(job.id).job.state === "cancelled"
      )
        return;
      const message =
        error instanceof Error ? error.message : "Unknown job failure";
      const changed = this.store.updateJob(job.id, {
        state: "failed",
        message,
      });
      this.events.emit("desktop.job-changed", changed);
      this.notifyTerminal(changed);
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private notifyTerminal(job: DesktopJob): void {
    const subject =
      job.kind === "history-import"
        ? "History import"
        : job.kind === "connect"
          ? "Agent connection"
          : "Runtime task";
    let severity: "info" | "success" | "warning" | "error";
    let title: string;
    switch (job.state) {
      case "succeeded":
        severity = "success";
        title = `${subject} completed`;
        break;
      case "partially-succeeded":
        severity = "warning";
        title = `${subject} partially completed`;
        break;
      case "waiting-for-review":
        severity = "info";
        title = `${subject} needs review`;
        break;
      case "failed":
        severity = "error";
        title = `${subject} failed`;
        break;
      default:
        return;
    }
    const project = job.agentKind
      ? this.store.getAgentProject(job.agentKind)
      : undefined;
    const canOpenProject =
      project &&
      (job.state === "succeeded" || job.state === "partially-succeeded");
    const pendingDeliveries =
      job.kind === "history-import" &&
      (job.state === "succeeded" || job.state === "partially-succeeded")
        ? this.store.dueOutbox("9999-01-01T00:00:00.000Z").length
        : 0;
    const notification = this.store.createNotification({
      jobId: job.id,
      severity,
      title,
      body:
        pendingDeliveries > 0
          ? `${job.message} ${pendingDeliveries} telemetry event(s) are still being delivered in the background.`
          : job.message,
      actionRoute: canOpenProject
        ? `/project/${project.id}/sessions`
        : "/?notificationCenter=open",
    });
    this.events.emit("desktop.notification-created", notification);
  }
}
