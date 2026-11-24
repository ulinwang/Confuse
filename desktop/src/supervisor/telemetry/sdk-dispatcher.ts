import { z } from "zod";
import { AGENT_KINDS } from "../../shared/contracts";
import type { SecretStore } from "../keychain";
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
  private deliveryPromise?: Promise<LangfuseV6Delivery>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly baseUrl: string,
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
    const delivery = await this.getDelivery();
    await delivery.deliver(event);
  }

  private getDelivery(): Promise<LangfuseV6Delivery> {
    if (!this.deliveryPromise) {
      const pending = this.createDelivery();
      this.deliveryPromise = pending;
      pending.catch(() => {
        if (this.deliveryPromise === pending) this.deliveryPromise = undefined;
      });
    }
    return this.deliveryPromise;
  }

  private async createDelivery(): Promise<LangfuseV6Delivery> {
    const [publicKey, secretKey] = await Promise.all([
      this.secrets.get("LANGFUSE_INIT_PROJECT_PUBLIC_KEY"),
      this.secrets.get("LANGFUSE_INIT_PROJECT_SECRET_KEY"),
    ]);
    if (!publicKey || !secretKey) {
      throw new Error("The local Confuse project keys are not initialized");
    }
    return new LangfuseV6Delivery(
      this.createClient({
        baseUrl: this.baseUrl,
        publicKey,
        secretKey,
        environment: "confuse-desktop",
      }),
    );
  }

  async close(): Promise<void> {
    const pending = this.deliveryPromise;
    this.deliveryPromise = undefined;
    if (!pending) return;
    try {
      await (await pending).shutdown();
    } catch {
      return;
    }
  }
}
