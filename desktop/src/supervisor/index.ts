import { createAgentContext } from "./agents/context";
import { readSupervisorConfig } from "./config";
import { MacOsKeychain } from "./keychain";
import { LaunchAgentManager } from "./launch-agent";
import { NodeProcessRunner } from "./process";
import { DesktopAgentRuntimeAdapter } from "./runtime-adapter";
import { Supervisor } from "./supervisor";
import { SdkOutboxDispatcher } from "./telemetry/sdk-dispatcher";

async function main(): Promise<void> {
  const config = readSupervisorConfig();
  const command = process.argv[2];
  if (
    command === "--install-launch-agent" ||
    command === "--uninstall-launch-agent"
  ) {
    const manager = new LaunchAgentManager(config, new NodeProcessRunner());
    if (command === "--install-launch-agent") await manager.install();
    else await manager.uninstall();
    return;
  }
  if (command !== undefined)
    throw new Error(`Unknown supervisor command: ${command}`);

  const runner = new NodeProcessRunner();
  const secrets = new MacOsKeychain(runner);
  const supervisor = new Supervisor(config, {
    runner,
    secrets,
    onStopped: (exitCode) => {
      process.exitCode = exitCode;
    },
  });
  supervisor.setAgentAdapter(
    new DesktopAgentRuntimeAdapter({
      context: createAgentContext({
        transport: { type: "unix-socket", socketPath: config.socketPath },
      }),
      store: supervisor.store,
      onEnqueued: () => void supervisor.outbox.flush(),
    }),
  );
  supervisor.setOutboxDispatcher(
    new SdkOutboxDispatcher(secrets, config.webUrl),
  );
  const shutdown = () => void supervisor.stop(false);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await supervisor.start();
}

main().catch((error: unknown) => {
  console.error(
    "Confuse supervisor failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
