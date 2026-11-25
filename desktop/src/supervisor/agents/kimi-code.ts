import { join } from "node:path";
import type { AgentInfo, ConnectAgentSelection } from "../../shared/contracts";
import { agentPaths, connectWithWrites, normalize } from "./adapter-utils";
import { findExecutable, pathExists, readCliVersion } from "./discovery";
import {
  createPreview,
  readTextIfExists,
  removeManagedBlock,
  replaceManagedBlock,
} from "./filesystem";
import { hookCommand, renderForwarderScript } from "./forwarder";
import type { AgentAdapter, AgentContext, PlannedWrite } from "./types";

const KIND = "kimi-code" as const;
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "TurnStarted",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "Notification",
];
const START = "# >>> confuse-agent-connector:kimi-code >>>";
const END = "# <<< confuse-agent-connector:kimi-code <<<";

function paths(selection: ConnectAgentSelection, context: AgentContext) {
  const resolved = agentPaths(
    selection,
    context,
    context.env.KIMI_CODE_HOME,
    join(context.homeDir, ".kimi-code"),
    "config.toml",
  );
  return {
    ...resolved,
    scriptPath: join(resolved.home, "hooks", "confuse-forward.mjs"),
  };
}

function block(command: string): string {
  const rules = EVENTS.map(
    (event) =>
      `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 2`,
  ).join("\n\n");
  return `${START}\n${rules}\n${END}`;
}

async function plan(
  selection: ConnectAgentSelection,
  context: AgentContext,
  install: boolean,
): Promise<PlannedWrite[]> {
  const target = paths(selection, context);
  const source = await readTextIfExists(target.configPath);
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
  const afterConfig = install
    ? replaceManagedBlock(source ?? "", START, END, block(command))
    : removeManagedBlock(source ?? "", START, END);
  return [
    {
      path: target.configPath,
      before: source,
      after: !install && source === null ? null : afterConfig,
      preview: install
        ? block(command)
        : `- ${START}\n- Confuse Kimi Code hooks removed`,
    },
    {
      path: target.scriptPath,
      before: existingScript,
      after: install ? renderForwarderScript(context.transport) : null,
      preview: install
        ? "+ Confuse local, fail-open Kimi Code forwarding script"
        : "- Confuse Kimi Code forwarding script",
    },
  ];
}

export const kimiCodeAdapter: AgentAdapter = {
  kind: KIND,
  displayName: "Kimi Code",

  async discover(context) {
    const target = paths({ kind: KIND, importHistory: false }, context);
    const executable = await findExecutable("kimi", context);
    const version = await readCliVersion(executable, ["--version"], context);
    const installed =
      executable !== undefined || (await pathExists(target.home));
    const info: AgentInfo = {
      kind: KIND,
      displayName: this.displayName,
      installed,
      ...(version === undefined ? {} : { version }),
      configPath: target.configPath,
      connectionState: "not-connected",
      liveCaptureSupported: true,
      historySupported: true,
      ...(!installed
        ? {
            message: "Kimi Code CLI and default data directory were not found.",
          }
        : {}),
    };
    return info;
  },

  async preview(selection, context) {
    const writes = await plan(selection, context, true);
    return createPreview(
      KIND,
      writes,
      "Adds local lifecycle hooks without reading session history.",
    );
  },

  async connect(selection, context) {
    const discovered = await this.discover(context);
    if (!discovered.installed) throw new Error("Kimi Code is not installed");
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, true),
      "connected",
      "Kimi Code lifecycle hooks are configured for local Confuse forwarding.",
    );
  },

  async disconnect(selection, context) {
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, false),
      "not-connected",
      "Confuse hooks were removed from Kimi Code.",
    );
  },

  async detectStatus(selection, context) {
    const target = paths(selection, context);
    const [config, script] = await Promise.all([
      readTextIfExists(target.configPath),
      readTextIfExists(target.scriptPath),
    ]);
    const command = hookCommand(context, target.scriptPath, KIND);
    return config?.includes(block(command)) &&
      script?.includes("confuse-agent-hook")
      ? "connected"
      : "not-connected";
  },

  normalizeEvent(payload, now) {
    return normalize(KIND, payload, now);
  },
};
