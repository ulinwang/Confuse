import type { AgentRuntimeAdapter } from "./adapters";
import { createAgentContext } from "./agents/context";
import type { AgentContext } from "./agents/types";
import { ComposeManager } from "./compose";
import { ensurePrivateDirectory, type SupervisorConfig } from "./config";
import { SupervisorEvents } from "./events";
import { HealthChecker } from "./health";
import { JobManager } from "./jobs";
import { MacOsKeychain, type SecretStore } from "./keychain";
import { OutboxWorker, type OutboxDispatcher } from "./outbox";
import { NodeProcessRunner, type ProcessRunner } from "./process";
import { SupervisorRouter } from "./router";
import { DesktopAgentRuntimeAdapter } from "./runtime-adapter";
import { SupervisorSocketServer } from "./socket-server";
import { DesktopStore } from "./store";
import { SdkOutboxDispatcher } from "./telemetry/sdk-dispatcher";

export interface SupervisorDependencies {
  runner?: ProcessRunner;
  secrets?: SecretStore;
  fetch?: typeof fetch;
  agentContext?: Partial<AgentContext>;
  onStopped?: (exitCode: number) => void;
}

export class Supervisor {
  readonly store: DesktopStore;
  readonly events: SupervisorEvents;
  readonly jobs: JobManager;
  readonly outbox: OutboxWorker;
  readonly router: SupervisorRouter;
  readonly compose: ComposeManager;
  readonly health: HealthChecker;
  private readonly socket: SupervisorSocketServer;
  private sdkDispatcher: SdkOutboxDispatcher;
  private readonly startupAbort = new AbortController();
  private readonly onStopped?: (exitCode: number) => void;
  private runtimePromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private quitPromise?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly config: SupervisorConfig,
    dependencies: SupervisorDependencies = {},
  ) {
    ensurePrivateDirectory(config.stateDir);
    const runner = dependencies.runner ?? new NodeProcessRunner();
    const secrets = dependencies.secrets ?? new MacOsKeychain(runner);
    this.onStopped = dependencies.onStopped;
    this.store = new DesktopStore(config.databasePath);
    this.store.initializeState(config.webUrl);
    this.events = new SupervisorEvents();
    this.jobs = new JobManager(this.store, this.events);
    this.outbox = new OutboxWorker(this.store, config.outboxPollMs, () => {
      if (this.stopping) return;
      const notification = this.store.createNotification({
        severity: "warning",
        title: "Background delivery is retrying",
        body: "A local observability event could not be delivered. Confuse will retry automatically.",
        actionRoute: "notifications",
      });
      this.events.emit("desktop.notification-created", notification);
    });
    this.compose = new ComposeManager(config, secrets, runner);
    this.health = new HealthChecker(config, runner, dependencies.fetch);
    this.sdkDispatcher = new SdkOutboxDispatcher(secrets, config.webUrl);
    this.outbox.setDispatcher((record) => this.sdkDispatcher.dispatch(record));
    const agentContext = createAgentContext({
      ...dependencies.agentContext,
      transport: dependencies.agentContext?.transport ?? {
        type: "unix-socket",
        socketPath: config.socketPath,
      },
    });
    const agentAdapter = new DesktopAgentRuntimeAdapter({
      context: agentContext,
      store: this.store,
      onEnqueued: () => void this.outbox.flush(),
    });
    this.router = new SupervisorRouter(this.store, this.jobs, this.events, () =>
      this.quit(),
    );
    this.router.setAgentAdapter(agentAdapter);
    this.socket = new SupervisorSocketServer(
      config.socketPath,
      this.router,
      this.events,
      (payload) => agentAdapter.ingestLiveEvent(payload),
    );
  }

  setAgentAdapter(adapter: AgentRuntimeAdapter): void {
    this.router.setAgentAdapter(adapter);
    this.socket.setAgentEventHandler(
      adapter instanceof DesktopAgentRuntimeAdapter
        ? (payload) => adapter.ingestLiveEvent(payload)
        : undefined,
    );
  }

  setOutboxDispatcher(
    dispatcher: OutboxDispatcher | SdkOutboxDispatcher,
  ): void {
    if (dispatcher instanceof SdkOutboxDispatcher) {
      this.sdkDispatcher = dispatcher;
      this.outbox.setDispatcher((record) => dispatcher.dispatch(record));
      return;
    }
    this.outbox.setDispatcher(dispatcher);
  }

  async start(options: { runtime?: boolean } = {}): Promise<void> {
    await this.socket.listen();
    this.jobs.start();
    this.outbox.start();
    if (options.runtime !== false) this.runtimePromise = this.startRuntime();
  }

  private async startRuntime(): Promise<void> {
    this.changeRuntime("starting");
    try {
      if (!(await this.health.webIsReady())) {
        const hasRunningServices = await this.compose.hasRunningServices();
        await this.health.preflight({ allowOccupiedPorts: hasRunningServices });
        const secrets = await this.compose.start(this.startupAbort.signal);
        await this.health.waitUntilReady(this.startupAbort.signal);
        await this.health.verifyIngestion(secrets);
      }
      if (!this.stopping) this.changeRuntime("ready");
    } catch (error) {
      if (this.stopping) return;
      this.changeRuntime("degraded");
      const notification = this.store.createNotification({
        severity: "error",
        title: "Confuse runtime needs attention",
        body:
          error instanceof Error
            ? error.message
            : "The local runtime could not start",
        actionRoute: "notifications",
      });
      this.events.emit("desktop.notification-created", notification);
    }
  }

  private changeRuntime(
    runtime: "starting" | "ready" | "degraded" | "stopped",
  ): void {
    const state = this.store.updateDesktopState({ runtime });
    this.events.emit("desktop.state-changed", state);
  }

  private quit(): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    this.quitPromise = this.performQuit().catch((error: unknown) => {
      this.quitPromise = undefined;
      this.stopping = false;
      this.changeRuntime("degraded");
      throw error;
    });
    return this.quitPromise;
  }

  private async performQuit(): Promise<void> {
    this.stopping = true;
    this.startupAbort.abort();
    this.changeRuntime("stopped");
    await this.runtimePromise?.catch(() => undefined);
    try {
      await this.compose.stop();
    } catch (error) {
      const notification = this.store.createNotification({
        severity: "error",
        title: "Confuse containers could not stop",
        body:
          error instanceof Error
            ? error.message
            : "Docker Compose could not stop cleanly",
        actionRoute: "notifications",
      });
      this.events.emit("desktop.notification-created", notification);
      throw error;
    }
    await this.jobs.stop();
    await this.outbox.stop();
    await this.sdkDispatcher.close();
    const timer = setTimeout(() => {
      this.stopPromise = this.finalizeStop();
    }, 25);
    timer.unref();
  }

  stop(stopCompose = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(stopCompose);
    return this.stopPromise;
  }

  private async performStop(stopCompose: boolean): Promise<void> {
    this.stopping = true;
    this.startupAbort.abort();
    this.changeRuntime("stopped");
    await this.runtimePromise?.catch(() => undefined);
    if (stopCompose) await this.compose.stop();
    await this.jobs.stop();
    await this.outbox.stop();
    await this.sdkDispatcher.close();
    await this.finalizeStop();
  }

  private async finalizeStop(): Promise<void> {
    await this.socket.close();
    this.store.close();
    this.onStopped?.(0);
  }
}
