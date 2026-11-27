import type { PlannedWrite } from "./types";
import { readTextIfExists } from "./filesystem";

export interface JsonHookHandler {
  type: "command";
  command: string;
  timeout: number;
  statusMessage: string;
  async?: boolean;
}

interface HookGroup {
  matcher?: string;
  hooks: JsonHookHandler[];
  [key: string]: unknown;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function readJsonObject(path: string): Promise<{
  source: string | null;
  value: Record<string, unknown>;
}> {
  const source = await readTextIfExists(path);
  if (source === null || source.trim() === "") return { source, value: {} };
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return { source, value: parsed as Record<string, unknown> };
}

function groupsFor(
  config: Record<string, unknown>,
  event: string,
  create: boolean,
): HookGroup[] {
  const hooks = config.hooks;
  if (hooks === undefined) {
    if (!create) return [];
    config.hooks = {};
    return groupsFor(config, event, create);
  }
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("Expected hooks to be a JSON object");
  }
  const record = hooks as Record<string, unknown>;
  const existing = record[event];
  if (existing === undefined) {
    if (create) {
      record[event] = [];
      return record[event] as HookGroup[];
    }
    return [];
  }
  if (!Array.isArray(existing))
    throw new Error(`Expected hooks.${event} to be an array`);
  for (const group of existing) {
    if (
      !group ||
      typeof group !== "object" ||
      !Array.isArray((group as HookGroup).hooks)
    ) {
      throw new Error(
        `Expected every hooks.${event} group to contain a hooks array`,
      );
    }
  }
  return existing as HookGroup[];
}

export function addJsonHooks(
  config: Record<string, unknown>,
  handlers: Record<string, JsonHookHandler>,
): void {
  for (const [event, handler] of Object.entries(handlers)) {
    const groups = groupsFor(config, event, true);
    const exists = groups.some((group) =>
      group.hooks.some(
        (candidate) =>
          candidate.type === "command" && candidate.command === handler.command,
      ),
    );
    if (!exists) groups.push({ hooks: [handler] });
  }
}

export function removeJsonHooks(
  config: Record<string, unknown>,
  command: string,
): void {
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const groups = value as HookGroup[];
    for (const group of groups) {
      group.hooks = group.hooks.filter(
        (handler) =>
          !(handler.type === "command" && handler.command === command),
      );
    }
    const remaining = groups.filter((group) => group.hooks.length > 0);
    if (remaining.length === 0)
      delete (hooks as Record<string, unknown>)[event];
    else (hooks as Record<string, unknown>)[event] = remaining;
  }
  if (Object.keys(hooks).length === 0) delete config.hooks;
}

export function hasJsonHooks(
  config: Record<string, unknown>,
  command: string,
  events: string[],
): boolean {
  return events.every((event) =>
    groupsFor(config, event, false).some((group) =>
      group.hooks.some(
        (handler) => handler.type === "command" && handler.command === command,
      ),
    ),
  );
}

export function serializeJsonHookPlan(
  path: string,
  source: string | null,
  config: Record<string, unknown>,
  addedPreview: string,
): PlannedWrite {
  return {
    path,
    before: source,
    after: `${JSON.stringify(config, null, 2)}\n`,
    preview: addedPreview,
  };
}
