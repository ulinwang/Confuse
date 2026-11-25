import { join } from "node:path";
import type { AgentInfo, ConnectAgentSelection } from "../../shared/contracts";
import {
  agentPaths,
  connectWithWrites,
  normalize,
  unchangedResult,
  unsupportedPreview,
} from "./adapter-utils";
import {
  findExecutable,
  pathExists,
  readBundleMetadata,
  readCliVersion,
} from "./discovery";
import {
  createPreview,
  readTextIfExists,
  removeManagedBlock,
  replaceManagedBlock,
} from "./filesystem";
import { renderDshTransport } from "./forwarder";
import type { AgentAdapter, AgentContext, PlannedWrite } from "./types";

const KIND = "deepseek-harness" as const;
const START = "# >>> confuse-agent-connector:deepseek-harness >>>";
const END = "# <<< confuse-agent-connector:deepseek-harness <<<";
const PLUGIN_ID = "confuse-session-telemetry";

function isSupportedDshVersion(version: string | undefined): boolean {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && (minor === 1 || minor === 2);
}

function paths(selection: ConnectAgentSelection, context: AgentContext) {
  const resolved = agentPaths(
    selection,
    context,
    context.env.DSH_HOME,
    join(context.homeDir, ".dsh"),
    "cordis.patch.yml",
  );
  return {
    ...resolved,
    pluginPath: join(resolved.home, "confuse-plugin", "index.js"),
  };
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function patchBlock(pluginPath: string): string {
  return `${START}\n- insert:\n    - id: ${PLUGIN_ID}\n      name: ${yamlString(pluginPath)}\n${END}`;
}

function renderPlugin(context: AgentContext): string {
  return `// Confuse native DeepSeek Harness session telemetry backend.
import { SessionTelemetryBackend, SessionTelemetryCoordinator } from '@deepseek-ai/dsh-session-telemetry';
${renderDshTransport(context.transport)}
export default class ConfuseSessionTelemetryBackend extends SessionTelemetryBackend {
  static inject = ['sessions'];

  constructor(ctx) {
    super(ctx);
    this.sharing = 'full';
    this.pending = [];
    this.draining = Promise.resolve();
    this.coordinator = new SessionTelemetryCoordinator(ctx, {
      emit: (record) => this.emit(record),
      shutdown: () => this.shutdown(),
    }, { capture: 'live', includeHistory: false });
  }

  emit(record) {
    if (this.pending.length >= 256) return;
    this.pending.push(record);
    this.draining = this.draining.then(() => this.drain());
  }

  async drain() {
    while (this.pending.length > 0) {
      const record = this.pending.shift();
      await postJson({
        source: 'confuse-agent-hook',
        agent: 'deepseek-harness',
        sentAt: new Date().toISOString(),
        payload: record,
      });
    }
  }

  async shutdown() {
    await this.draining;
    await this.drain();
  }
}
`;
}

async function plan(
  selection: ConnectAgentSelection,
  context: AgentContext,
  install: boolean,
): Promise<PlannedWrite[]> {
  const target = paths(selection, context);
  const source = await readTextIfExists(target.configPath);
  const existingPlugin = await readTextIfExists(target.pluginPath);
  if (
    existingPlugin !== null &&
    !existingPlugin.includes("ConfuseSessionTelemetryBackend")
  ) {
    throw new Error(
      `Refusing to replace an unmanaged DSH plugin: ${target.pluginPath}`,
    );
  }
  return [
    {
      path: target.configPath,
      before: source,
      after: install
        ? replaceManagedBlock(
            source ?? "",
            START,
            END,
            patchBlock(target.pluginPath),
          )
        : !source
          ? null
          : removeManagedBlock(source, START, END),
      preview: install
        ? patchBlock(target.pluginPath)
        : "- Confuse native DSH telemetry plugin registration",
    },
    {
      path: target.pluginPath,
      before: existingPlugin,
      after: install ? renderPlugin(context) : null,
      preview: install
        ? "+ Confuse native SessionTelemetryBackend (live capture only; no OTLP logs mapping)"
        : "- Confuse native DSH telemetry plugin",
    },
  ];
}

export const deepSeekHarnessAdapter: AgentAdapter = {
  kind: KIND,
  displayName: "DeepSeek Harness",

  async discover(context) {
    const target = paths({ kind: KIND, importHistory: false }, context);
    const executable = await findExecutable("dsh", context);
    const cliVersion = await readCliVersion(executable, ["--version"], context);
    let applicationPath: string | undefined;
    let appVersion: string | undefined;
    for (const directory of context.applicationDirs) {
      for (const name of ["DeepSeek Harness.app", "Harness.app", "dsh.app"]) {
        const candidate = join(directory, name);
        const metadata = await readBundleMetadata(candidate);
        if (
          metadata.bundleId &&
          /deepseek.*(harness|dsh)/i.test(metadata.bundleId)
        ) {
          applicationPath = candidate;
          appVersion = metadata.version;
          break;
        }
      }
      if (applicationPath) break;
    }
    const version = cliVersion ?? appVersion;
    const installed =
      executable !== undefined ||
      applicationPath !== undefined ||
      (await pathExists(target.home));
    const supported = installed && isSupportedDshVersion(version);
    const info: AgentInfo = {
      kind: KIND,
      displayName: this.displayName,
      installed,
      ...(version === undefined ? {} : { version }),
      ...(applicationPath === undefined ? {} : { applicationPath }),
      configPath: target.configPath,
      connectionState:
        installed && !supported ? "unsupported" : "not-connected",
      liveCaptureSupported: supported,
      historySupported: supported,
      message: !installed
        ? "DeepSeek Harness CLI, Desktop bundle, and default home were not found."
        : supported
          ? "Supported Developer Preview; Confuse installs a native SessionTelemetryBackend, not an OTLP Logs bridge."
          : "This DSH version is not on the verified 0.1.x/0.2.x telemetry API range; configuration will not be changed.",
    };
    return info;
  },

  async preview(selection, context) {
    const discovered = await this.discover(context);
    if (!discovered.installed || discovered.connectionState === "unsupported") {
      return unsupportedPreview(
        KIND,
        discovered.message ?? "DeepSeek Harness is unavailable",
      );
    }
    return createPreview(
      KIND,
      await plan(selection, context, true),
      "Installs a native live SessionTelemetryBackend; historical replay remains a separate explicit import.",
    );
  },

  async connect(selection, context) {
    const discovered = await this.discover(context);
    if (!discovered.installed || discovered.connectionState === "unsupported") {
      return unchangedResult(
        KIND,
        selection,
        discovered.installed ? "unsupported" : "not-connected",
        discovered.message ?? "DeepSeek Harness is unavailable",
      );
    }
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, true),
      "connected",
      "The Confuse native DSH telemetry plugin is configured; restart DSH to load it.",
    );
  },

  async disconnect(selection, context) {
    const discovered = await this.discover(context);
    if (discovered.connectionState === "unsupported") {
      return unchangedResult(
        KIND,
        selection,
        "unsupported",
        "Unsupported DSH configuration was not changed.",
      );
    }
    return connectWithWrites(
      KIND,
      selection,
      context,
      await plan(selection, context, false),
      "not-connected",
      "The Confuse native DSH telemetry plugin was removed.",
    );
  },

  async detectStatus(selection, context) {
    const discovered = await this.discover(context);
    if (discovered.connectionState === "unsupported") return "unsupported";
    const target = paths(selection, context);
    const [config, plugin] = await Promise.all([
      readTextIfExists(target.configPath),
      readTextIfExists(target.pluginPath),
    ]);
    return config?.includes(patchBlock(target.pluginPath)) &&
      plugin?.includes("ConfuseSessionTelemetryBackend")
      ? "connected"
      : "not-connected";
  },

  normalizeEvent(payload, now) {
    return normalize(KIND, payload, now);
  },
};
