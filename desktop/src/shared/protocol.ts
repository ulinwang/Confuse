import type { DesktopChannel, DesktopEventMap } from "./contracts";

export interface SupervisorRequest {
  id: string;
  channel: DesktopChannel;
  payload: unknown;
}

export interface SupervisorResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface SupervisorEvent {
  event: keyof DesktopEventMap;
  payload: DesktopEventMap[keyof DesktopEventMap];
}

export function parseSupervisorMessage(
  line: string,
): SupervisorResponse | SupervisorEvent {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") {
    throw new Error("Invalid supervisor message");
  }
  if ("event" in value) {
    return value as SupervisorEvent;
  }
  if ("id" in value && "ok" in value) {
    return value as SupervisorResponse;
  }
  throw new Error("Invalid supervisor message");
}
