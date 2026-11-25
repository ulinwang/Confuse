import { contextBridge, ipcRenderer } from "electron";
import type {
  ConfuseBridge,
  DesktopChannel,
  DesktopEventMap,
  DesktopRequest,
  DesktopResponse,
} from "../shared/contracts";

const desktopChannels = new Set<DesktopChannel>([
  "desktop.get-state",
  "desktop.complete-onboarding",
  "desktop.reopen-onboarding",
  "desktop.quit",
  "agents.scan",
  "agents.connect",
  "history.preview",
  "history.start",
  "jobs.cancel",
  "jobs.retry",
  "notifications.list",
  "notifications.mark-read",
]);

const desktopEvents = new Set<keyof DesktopEventMap>([
  "desktop.state-changed",
  "desktop.job-changed",
  "desktop.notification-created",
]);

const bridge: ConfuseBridge = {
  invoke<C extends DesktopChannel>(
    channel: C,
    request: DesktopRequest<C>,
  ): Promise<DesktopResponse<C>> {
    if (!desktopChannels.has(channel)) {
      return Promise.reject(new Error("Unsupported desktop channel"));
    }
    return ipcRenderer.invoke("confuse:invoke", { channel, request });
  },

  subscribe<C extends keyof DesktopEventMap>(
    channel: C,
    listener: (event: DesktopEventMap[C]) => void,
  ): () => void {
    if (!desktopEvents.has(channel)) {
      throw new Error("Unsupported desktop event");
    }

    const wrapped = (
      _event: Electron.IpcRendererEvent,
      message: { channel: C; payload: DesktopEventMap[C] },
    ) => {
      if (message.channel === channel) {
        listener(message.payload);
      }
    };
    ipcRenderer.on("confuse:event", wrapped);
    return () => ipcRenderer.off("confuse:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("confuse", bridge);
