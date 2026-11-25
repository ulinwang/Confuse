import { z } from "zod";
import { AGENT_KINDS } from "../shared/contracts";
import type {
  ConnectAgentSelection,
  DesktopChannel,
} from "../shared/contracts";
import type { SupervisorRequest } from "../shared/protocol";
import type { AgentRuntimeAdapter } from "./adapters";
import type { SupervisorEvents } from "./events";
import type { JobManager } from "./jobs";
import type { DesktopStore } from "./store";

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

const agentKind = z.enum(AGENT_KINDS);
const selection = z
  .object({
    kind: agentKind,
    configPath: z.string().min(1).max(4_096).optional(),
    importHistory: z.boolean(),
  })
  .strict();
const selections = z.object({ selections: z.array(selection).max(4) }).strict();
const kinds = z.object({ kinds: z.array(agentKind).min(1).max(4) }).strict();

const payloadSchemas = {
  "desktop.get-state": z.undefined(),
  "desktop.complete-onboarding": selections,
  "desktop.reopen-onboarding": z.undefined(),
  "desktop.quit": z.undefined(),
  "agents.scan": z.undefined(),
  "agents.connect": selections,
  "history.preview": kinds,
  "history.start": kinds,
  "jobs.cancel": z.object({ id: z.string().uuid() }).strict(),
  "jobs.retry": z.object({ id: z.string().uuid() }).strict(),
  "notifications.list": z.undefined(),
  "notifications.mark-read": z
    .object({ ids: z.array(z.string().uuid()).max(500) })
    .strict(),
} satisfies Record<DesktopChannel, z.ZodType>;

const requestSchema = z
  .object({
    id: z.string().min(1).max(128),
    channel: z.enum(
      Object.keys(payloadSchemas) as [DesktopChannel, ...DesktopChannel[]],
    ),
    payload: z.unknown().optional(),
  })
  .strict();

function uniqueKinds<T extends { kind: string }>(values: T[]): void {
  if (new Set(values.map((value) => value.kind)).size !== values.length) {
    throw new RequestError(
      "INVALID_REQUEST",
      "Each Agent may be selected only once",
    );
  }
}

export class SupervisorRouter {
  private adapter?: AgentRuntimeAdapter;

  constructor(
    private readonly store: DesktopStore,
    private readonly jobs: JobManager,
    private readonly events: SupervisorEvents,
    private readonly quit: () => Promise<void>,
  ) {
    jobs.register("connect", async (payload, context) => {
      const { selections: selected } = selections.parse(payload);
      const current = selected[0];
      const result = await this.requireAdapter().connect(current, context);
      const agentMessage = `Agent connection: ${result.message}`;
      if (current.importHistory && result.state !== "waiting-for-review") {
        const history = await this.requireAdapter().importHistory(
          current.kind,
          context,
        );
        return {
          state: history.state,
          message: `${agentMessage}; History import: ${history.message}`,
        };
      }
      return {
        ...result,
        message: `${agentMessage}; History import: ${
          current.importHistory ? "waiting for Agent review" : "not requested"
        }`,
      };
    });
    jobs.register("history-import", async (payload, context) => {
      const parsed = kinds.parse(payload);
      const result = await this.requireAdapter().importHistory(
        parsed.kinds[0],
        context,
      );
      return { ...result, message: `History import: ${result.message}` };
    });
  }

  setAgentAdapter(adapter: AgentRuntimeAdapter): void {
    this.adapter = adapter;
  }

  async handle(value: unknown): Promise<unknown> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success)
      throw new RequestError("INVALID_REQUEST", "Invalid supervisor request");
    const request = parsed.data as SupervisorRequest;
    const payloadResult = payloadSchemas[request.channel].safeParse(
      request.payload,
    );
    if (!payloadResult.success) {
      throw new RequestError(
        "INVALID_REQUEST",
        `Invalid payload for ${request.channel}`,
      );
    }
    const payload = payloadResult.data;

    switch (request.channel) {
      case "desktop.get-state":
        return this.store.getDesktopState();
      case "desktop.complete-onboarding": {
        const input = payload as z.infer<typeof selections>;
        const result = this.connect(input);
        const state = this.store.updateDesktopState({ firstRunComplete: true });
        this.events.emit("desktop.state-changed", state);
        return result;
      }
      case "desktop.reopen-onboarding": {
        const state = this.store.updateDesktopState({
          firstRunComplete: false,
        });
        this.events.emit("desktop.state-changed", state);
        return undefined;
      }
      case "desktop.quit":
        await this.quit();
        return undefined;
      case "agents.scan":
        return this.requireAdapter().scan();
      case "agents.connect":
        return this.connect(payload as z.infer<typeof selections>);
      case "history.preview":
        return this.requireAdapter().previewHistory(
          (payload as z.infer<typeof kinds>).kinds,
        );
      case "history.start":
        return this.startHistory(payload as z.infer<typeof kinds>);
      case "jobs.cancel": {
        try {
          this.jobs.cancel((payload as { id: string }).id);
        } catch {
          throw new RequestError("NOT_FOUND", "Job not found");
        }
        return undefined;
      }
      case "jobs.retry": {
        try {
          const job = this.jobs.retry((payload as { id: string }).id);
          return { jobId: job.id };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Could not retry job";
          throw new RequestError(
            message === "Job not found" ? "NOT_FOUND" : "INVALID_REQUEST",
            message,
          );
        }
      }
      case "notifications.list":
        return this.store.listNotifications();
      case "notifications.mark-read":
        this.store.markNotificationsRead((payload as { ids: string[] }).ids);
        return undefined;
    }
  }

  private connect(input: { selections: ConnectAgentSelection[] }): {
    jobIds: string[];
  } {
    if (input.selections.length > 0) this.requireAdapter();
    uniqueKinds(input.selections);
    return {
      jobIds: input.selections.map(
        (item) =>
          this.jobs.enqueue({
            kind: "connect",
            agentKind: item.kind,
            payload: { selections: [item] },
          }).id,
      ),
    };
  }

  private startHistory(input: { kinds: z.infer<typeof agentKind>[] }): {
    jobIds: string[];
  } {
    this.requireAdapter();
    const unique = [...new Set(input.kinds)];
    return {
      jobIds: unique.map(
        (kind) =>
          this.jobs.enqueue({
            kind: "history-import",
            agentKind: kind,
            payload: { kinds: [kind] },
          }).id,
      ),
    };
  }

  private requireAdapter(): AgentRuntimeAdapter {
    if (!this.adapter) {
      throw new RequestError(
        "ADAPTER_UNAVAILABLE",
        "Agent connectors are not installed in this supervisor build",
      );
    }
    return this.adapter;
  }
}
