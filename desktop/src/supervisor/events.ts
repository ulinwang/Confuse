import type { DesktopEventMap } from "../shared/contracts";
import type { SupervisorEvent } from "../shared/protocol";

type Listener = (event: SupervisorEvent) => void;

export class SupervisorEvents {
  private readonly listeners = new Set<Listener>();

  emit<C extends keyof DesktopEventMap>(
    event: C,
    payload: DesktopEventMap[C],
  ): void {
    const message = { event, payload } as SupervisorEvent;
    for (const listener of this.listeners) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
