import { join } from "node:path";
import type { AgentInfo, ConnectAgentSelection } from "../../shared/contracts";
import { agentPaths, connectWithWrites, normalize } from "./adapter-utils";
import {
  findExecutable,
  pathExists,
  readBundleMetadata,
  readCliVersion,
} from "./discovery";
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

const KIND = "claude-code" as const;
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "Notification",
];

function paths(selection: ConnectAgentSelection, context: AgentContext) {
  const resolved = agentPaths(
    selection,
    context,
    context.env.CLAUDE_CONFIG_DIR,
    join(context.homeDir, ".claude"),
    "settings.json",
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
  return [
    {
      ...serializeJsonHookPlan(
        target.configPath,
        source,
        value,
        install
          ? `+ Confuse Claude Code hooks: ${EVENTS.join(", ")}\n+ ${command}`
          : "- Confuse Claude Code lifecycle hooks",
      ),
      after:
        !install && source === null
          ? null
          : JSON.stringify(value, null, 2) + "\n",
    },
    {
      path: target.scriptPath,
      before: existingScript,
      after: install ? renderForwarderScript(context.transport) : null,
      preview: install
        ? "+ Confuse local, fail-open Claude Code forwarding script"
        : "- Confuse Claude Code forwarding script",
    },
  ];
}

export const claudeCodeAdapter: AgentAdapter = {
  kind: KIND,
  displayName: "Claude Code",

  async discover(context) {
    const target = paths({ kind: KIND, importHistory: false }, context);
    const executable = await findExecutable("claude", context);
    let applicationPath: string | undefined;
    let appVersion: string | undefined;
    for (const directory of context.applicationDirs) {
      const candidate = join(directory, "Claude.app");
      const metadata = await readBundleMetadata(candidate);
      if (metadata.bundleId?.startsWith("com.anthropic.")) {
        applicationPath = candidate;
        appVersion = metadata.version;
        break;
      }
    }
    const cliVersion = await readCliVersion(executable, ["--version"], context);
    const version = cliVersion ?? appVersion;
    const installed =
      executable !== undefined ||
      applicationPath !== undefined ||
      (await pathExists(target.home));
    const info: AgentInfo = {
      kind: KIND,
      displayName: this.displayName,
      installed,
      ...(version === undefined ? {} : { version }),
      ...(applicationPath === undefined ? {} : { applicationPath }),
      configPath: target.configPath,
      connectionState: "not-connected",
      liveCaptureSupported: true,
      historySupported: true,
      message: installed
        ? "Claude Code CLI and Desktop Code sessions only; ordinary Desktop Chat is not claimed as supported."
        : "Claude Code and its default configuration directory were not found.",
    };
    return info;
  },

  async preview(selection, context) {
    return createPreview(
      KIND,
      await plan(selection, context, true),
      "Adds local Claude Code lifecycle hooks without reading transcripts.",
    );
  },

  async connect(selection, context) {
    const discovered = await this.discover(context);
    if (!discovered.installed) throw new Error("Claude Code is not installed");
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, true),
      "connected",
      "Claude Code lifecycle hooks are configured for local Confuse forwarding.",
    );
  },

  async disconnect(selection, context) {
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, false),
      "not-connected",
      "Confuse hooks were removed from Claude Code.",
    );
  },

  async detectStatus(selection, context) {
    const target = paths(selection, context);
    const [{ value }, script] = await Promise.all([
      readJsonObject(target.configPath),
      readTextIfExists(target.scriptPath),
    ]);
    const command = hookCommand(context, target.scriptPath, KIND);
    return hasJsonHooks(value, command, EVENTS) &&
      script?.includes("confuse-agent-hook")
      ? "connected"
      : "not-connected";
  },

  normalizeEvent(payload, now) {
    return normalize(KIND, payload, now);
  },
};
