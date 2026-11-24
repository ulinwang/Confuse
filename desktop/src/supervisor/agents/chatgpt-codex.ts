import { join } from "node:path";
import type { AgentInfo, ConnectAgentSelection } from "../../shared/contracts";
import { agentPaths, connectWithWrites, normalize } from "./adapter-utils";
import { CODEX_HOOK_EVENTS } from "./codex-trust";
import { readBundleMetadata } from "./discovery";
import { createPreview, readTextIfExists } from "./filesystem";
import { hookCommand, renderForwarderScript } from "./forwarder";
import {
  addJsonHooks,
  hasJsonHooks,
  readJsonObject,
  removeJsonHooks,
  serializeJsonHookPlan,
  type JsonHookHandler,
} from "./json-hooks";
import type { AgentAdapter, AgentContext, PlannedWrite } from "./types";

const KIND = "chatgpt-codex" as const;
const EVENTS: string[] = [...CODEX_HOOK_EVENTS];

function paths(selection: ConnectAgentSelection, context: AgentContext) {
  const resolved = agentPaths(
    selection,
    context,
    context.env.CODEX_HOME,
    join(context.homeDir, ".codex"),
    "hooks.json",
  );
  return {
    ...resolved,
    scriptPath: join(resolved.home, "hooks", "confuse-forward.mjs"),
  };
}

function handlers(command: string): Record<string, JsonHookHandler> {
  return Object.fromEntries(
    EVENTS.map((event) => [
      event,
      {
        type: "command",
        command,
        timeout: 2,
        statusMessage: "Forwarding a local event to Confuse",
        ...(event === "SessionEnd" ? {} : { async: true }),
      },
    ]),
  );
}

async function plan(
  selection: ConnectAgentSelection,
  context: AgentContext,
  install: boolean,
): Promise<PlannedWrite[]> {
  const target = paths(selection, context);
  const { source, value } = await readJsonObject(target.configPath);
  const existingScript = await readTextIfExists(target.scriptPath);
  if (
    existingScript !== null &&
    !existingScript.includes("confuse-agent-hook")
  ) {
    throw new Error(
      `Refusing to replace an unmanaged script: ${target.scriptPath}`,
    );
  }
  const command = hookCommand(context, target.scriptPath, KIND);
  if (install) addJsonHooks(value, handlers(command));
  else removeJsonHooks(value, command);
  const afterConfig =
    !install && source === null ? null : JSON.stringify(value, null, 2) + "\n";
  return [
    {
      ...serializeJsonHookPlan(
        target.configPath,
        source,
        value,
        install
          ? `+ Confuse Codex hooks: ${EVENTS.join(", ")}\n+ ${command}`
          : "- Confuse Codex lifecycle hooks",
      ),
      after: afterConfig,
    },
    {
      path: target.scriptPath,
      before: existingScript,
      after: install ? renderForwarderScript(context.transport) : null,
      preview: install
        ? "+ Confuse local, fail-open Codex forwarding script"
        : "- Confuse Codex forwarding script",
    },
  ];
}

export const chatGptCodexAdapter: AgentAdapter = {
  kind: KIND,
  displayName: "ChatGPT Codex",

  async discover(context) {
    const target = paths({ kind: KIND, importHistory: false }, context);
    let applicationPath: string | undefined;
    let version: string | undefined;
    for (const directory of context.applicationDirs) {
      for (const appName of ["ChatGPT.app", "Codex.app"]) {
        const candidate = join(directory, appName);
        const metadata = await readBundleMetadata(candidate);
        if (metadata.bundleId === "com.openai.codex") {
          applicationPath = candidate;
          version = metadata.version;
          break;
        }
      }
      if (applicationPath) break;
    }
    const info: AgentInfo = {
      kind: KIND,
      displayName: this.displayName,
      installed: applicationPath !== undefined,
      ...(version === undefined ? {} : { version }),
      ...(applicationPath === undefined ? {} : { applicationPath }),
      configPath: target.configPath,
      connectionState: "not-connected",
      liveCaptureSupported: applicationPath !== undefined,
      historySupported: applicationPath !== undefined,
      message:
        applicationPath === undefined
          ? "ChatGPT.app or Codex.app with bundle ID com.openai.codex was not found; the Codex CLI is not required or substituted."
          : "Local Codex threads only. New hooks require review in Settings → Hooks / Review hooks.",
    };
    return info;
  },

  async preview(selection, context) {
    return createPreview(
      KIND,
      await plan(selection, context, true),
      "After installation, review and trust the exact hooks in ChatGPT Settings → Hooks / Review hooks.",
    );
  },

  async connect(selection, context) {
    const discovered = await this.discover(context);
    if (!discovered.installed)
      throw new Error("ChatGPT desktop Codex is not installed");
    const result = await connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, true),
      "waiting-for-review",
      "Hooks are installed but not yet trusted. Open ChatGPT Settings → Hooks / Review hooks, then verify a new local Codex thread.",
    );
    if ((await this.detectStatus(selection, context)) !== "connected") {
      return result;
    }
    const message = "Codex hooks are installed and trusted.";
    return {
      ...result,
      state: "connected",
      message,
      preview: { ...result.preview, message },
    };
  },

  async disconnect(selection, context) {
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, false),
      "not-connected",
      "Confuse hooks were removed from Codex; ChatGPT may retain their old trust record harmlessly.",
    );
  },

  async detectStatus(selection, context) {
    const target = paths(selection, context);
    const [{ value }, script] = await Promise.all([
      readJsonObject(target.configPath),
      readTextIfExists(target.scriptPath),
    ]);
    const command = hookCommand(context, target.scriptPath, KIND);
    if (
      !hasJsonHooks(value, command, EVENTS) ||
      !script?.includes("confuse-agent-hook")
    ) {
      return "not-connected";
    }
    return (await context.isCodexHookTrusted?.(command, target.configPath))
      ? "connected"
      : "waiting-for-review";
  },

  normalizeEvent(payload, now) {
    return normalize(KIND, payload, now);
  },
};
