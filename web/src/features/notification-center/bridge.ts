import { useSyncExternalStore } from "react";

export const AGENT_KINDS = [
  "kimi-code",
  "chatgpt-codex",
  "claude-code",
  "deepseek-harness",
] as const satisfies readonly AgentKind[];

export const AGENT_LABELS: Record<AgentKind, string> = {
  "kimi-code": "Kimi Code",
  "chatgpt-codex": "ChatGPT Codex",
  "claude-code": "Claude Code",
  "deepseek-harness": "DeepSeek Harness",
};

export function getConfuseBridge(): ConfuseBridge | null {
  return typeof window === "undefined" ? null : (window.confuse ?? null);
}

const subscribeToAvailability = () => () => undefined;
const getServerBridgeSnapshot = () => null;

export function useConfuseDesktopBridge() {
  return useSyncExternalStore(
    subscribeToAvailability,
    getConfuseBridge,
    getServerBridgeSnapshot,
  );
}

export function useConfuseDesktopAvailability() {
  return useConfuseDesktopBridge() !== null;
}
