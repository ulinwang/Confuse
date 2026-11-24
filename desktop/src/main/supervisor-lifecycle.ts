import path from "node:path";
import { app } from "electron";
import { readSupervisorConfig } from "../supervisor/config";
import { LaunchAgentManager } from "../supervisor/launch-agent";
import { NodeProcessRunner } from "../supervisor/process";

export async function installAndStartSupervisor(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Confuse desktop supervisor requires macOS");
  }

  const developmentRoot = path.resolve(__dirname, "../..");
  const applicationRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked")
    : developmentRoot;
  const resourceDir = app.isPackaged
    ? path.join(process.resourcesPath, "resources")
    : path.join(developmentRoot, "resources");
  const config = readSupervisorConfig({
    ...process.env,
    CONFUSE_STATE_DIR: process.env.CONFUSE_STATE_DIR ?? app.getPath("userData"),
    CONFUSE_RESOURCE_DIR: process.env.CONFUSE_RESOURCE_DIR ?? resourceDir,
    CONFUSE_WEB_IMAGE:
      process.env.CONFUSE_WEB_IMAGE ??
      (app.isPackaged ? undefined : "confuse-web:local"),
    CONFUSE_WORKER_IMAGE:
      process.env.CONFUSE_WORKER_IMAGE ??
      (app.isPackaged ? undefined : "confuse-worker:local"),
    CONFUSE_COMPOSE_FILE:
      process.env.CONFUSE_COMPOSE_FILE ?? path.join(resourceDir, "compose.yml"),
    CONFUSE_LAUNCH_AGENT_TEMPLATE:
      process.env.CONFUSE_LAUNCH_AGENT_TEMPLATE ??
      path.join(resourceDir, "com.confuse.supervisor.plist"),
    CONFUSE_SUPERVISOR_ENTRY:
      process.env.CONFUSE_SUPERVISOR_ENTRY ??
      path.join(applicationRoot, "dist", "supervisor", "index.mjs"),
  });

  await new LaunchAgentManager(config, new NodeProcessRunner()).install();
}
