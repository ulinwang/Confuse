import { z } from "zod";
import { AGENT_KINDS, type AgentKind } from "../../shared/contracts";
import type { AgentProjects } from "../agent-projects";
import type { OutboxRecord } from "../store";
import {
  createNodeLangfuseV6Client,
  LangfuseV6Delivery,
  type LangfuseV6Client,
  type NodeLangfuseV6Options,
} from "./langfuse-v6";

export type LangfuseClientFactory = (
  options: NodeLangfuseV6Options,
) => LangfuseV6Client;

const telemetryEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    observationId: z.string().regex(/^[a-f0-9]{16}$/),
    parentObservationId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
    agent: z.enum(AGENT_KINDS),
    sessionId: z.string().min(1),
    userId: z.string().optional(),
    name: z.string().min(1),
    type: z.enum(["agent", "event", "generation", "span", "tool"]),
    timestamp: z.string().optional(),
    endTimestamp: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    model: z.string().optional(),
    usageDetails: z.record(z.string(), z.number()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export class SdkOutboxDispatcher {
  private readonly deliveries = new Map<string, Promise<LangfuseV6Delivery>>();

  constructor(
    private readonly projects: AgentProjects,
    private readonly createClient: LangfuseClientFactory = createNodeLangfuseV6Client,
  ) {}

  async dispatch(record: OutboxRecord): Promise<void> {
    if (record.kind !== "telemetry") {
      throw new Error("Unsupported desktop outbox record");
    }
    const event = telemetryEventSchema.parse(record.payload);
    if (event.id !== record.id) {
      throw new Error("Desktop outbox record and event IDs do not match");
    }
    const projectId =
      typeof event.metadata?.projectId === "string"
        ? event.metadata.projectId
        : undefined;
    const delivery = await this.getDelivery(event.agent, projectId);
    await delivery.deliver(event);
  }

  private getDelivery(
    kind: AgentKind,
    projectId?: string,
  ): Promise<LangfuseV6Delivery> {
    const key = `${kind}:${projectId ?? "confuse-local"}`;
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const pending = this.createDelivery(kind, projectId);
    this.deliveries.set(key, pending);
    pending.catch(() => {
      if (this.deliveries.get(key) === pending) {
        this.deliveries.delete(key);
      }
    });
    return pending;
  }

  private async createDelivery(
    kind: AgentKind,
    projectId?: string,
  ): Promise<LangfuseV6Delivery> {
    const options = await this.projects.clientOptions(kind, projectId);
    return new LangfuseV6Delivery(
      this.createClient({ ...options, environment: "confuse-desktop" }),
    );
  }

  async close(): Promise<void> {
    const pending = [...this.deliveries.values()];
    this.deliveries.clear();
    await Promise.all(
      pending.map(async (delivery) => {
        try {
          await (await delivery).shutdown();
        } catch {
          return;
        }
      }),
    );
  }
}
