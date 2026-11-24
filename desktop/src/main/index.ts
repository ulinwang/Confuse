import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import type {
  DesktopChannel,
  DesktopNotification,
  DesktopState,
} from "../shared/contracts";
import { authenticateLocalSession } from "./auth";
import {
  initialWebUrl,
  normalizeLocalWebUrl,
  supervisorSocketPath,
} from "./config";
import { SupervisorClient } from "./supervisor-client";
import { installAndStartSupervisor } from "./supervisor-lifecycle";

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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let client: SupervisorClient | null = null;
let currentState: DesktopState | null = null;
let currentWebUrl = initialWebUrl();
let reloadTimer: NodeJS.Timeout | null = null;
let quitMode: "none" | "stopping" | "ui" | "full" = "none";
let fullQuitPromise: Promise<void> | null = null;

function showMainWindow(): void {
  if (!app.isReady()) {
    void app.whenReady().then(showMainWindow);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (
    !mainWindow ||
    BrowserWindow.fromWebContents(event.sender) !== mainWindow ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    return false;
  }

  try {
    return (
      new URL(event.senderFrame.url).origin === new URL(currentWebUrl).origin
    );
  } catch {
    return false;
  }
}

function openExternal(url: string): void {
  try {
    const target = new URL(url);
    if (target.protocol === "https:" || target.protocol === "mailto:") {
      void shell.openExternal(target.toString());
    }
  } catch {
    return;
  }
}

function scheduleReload(): void {
  if (reloadTimer || quitMode !== "none" || !mainWindow) {
    return;
  }
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void loadWebUrl(currentWebUrl);
  }, 3_000);
}

async function loadWebUrl(candidate: string | undefined): Promise<void> {
  const url = normalizeLocalWebUrl(candidate) ?? initialWebUrl();
  const window = mainWindow;
  if (!window || window.isDestroyed() || quitMode !== "none") {
    return;
  }

  currentWebUrl = url;
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  try {
    await authenticateLocalSession(url, window.webContents.session);
    if (mainWindow !== window || window.isDestroyed() || quitMode !== "none") {
      return;
    }
    await window.loadURL(url);
  } catch {
    if (mainWindow === window && quitMode === "none") {
      scheduleReload();
    }
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    title: "Confuse",
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#111111",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = window;

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (quitMode === "none" || quitMode === "stopping") {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === new URL(currentWebUrl).origin) {
        return;
      }
    } catch {
      // Invalid and cross-origin navigation are both blocked below.
    }
    event.preventDefault();
    openExternal(url);
  });
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  void loadWebUrl(currentState?.webUrl ?? currentWebUrl);
}

function updateState(state: DesktopState): void {
  currentState = state;
  const url = normalizeLocalWebUrl(state.webUrl);
  if (!url) {
    return;
  }

  try {
    if (new URL(url).origin !== new URL(currentWebUrl).origin) {
      void loadWebUrl(url);
    }
  } catch {
    void loadWebUrl(url);
  }
}

function showSystemNotification(
  desktopNotification: DesktopNotification,
): void {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: desktopNotification.title,
    body: desktopNotification.body,
  });
  notification.on("click", () => {
    showMainWindow();
    const route = desktopNotification.actionRoute;
    if (route) {
      try {
        const target = normalizeLocalWebUrl(
          new URL(route, currentWebUrl).toString(),
        );
        if (target) {
          void loadWebUrl(target);
        }
      } catch {
        return;
      }
    }
  });
  notification.show();
}

function broadcastEvent(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("confuse:event", { channel, payload });
  }
}

function clearReloadTimer(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

function closeUi(): void {
  clearReloadTimer();
  client?.close();
  tray?.destroy();
  tray = null;
}

function quitUi(): void {
  quitMode = "ui";
  closeUi();
  app.quit();
}

async function quitConfuse(): Promise<void> {
  if (fullQuitPromise) {
    return fullQuitPromise;
  }
  const supervisor = client;
  if (!supervisor) {
    dialog.showErrorBox(
      "Unable to quit Confuse",
      "The supervisor is unavailable, so Confuse could not stop its local services.",
    );
    return;
  }

  fullQuitPromise = (async () => {
    quitMode = "stopping";
    try {
      await supervisor.request("desktop.quit", undefined);
      quitMode = "full";
      closeUi();
      app.quit();
    } catch (error) {
      if (quitMode !== "stopping") {
        return;
      }
      quitMode = "none";
      dialog.showErrorBox(
        "Unable to quit Confuse",
        `Confuse could not stop its local services. They are still running.\n\n${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      fullQuitPromise = null;
    }
  })();

  return fullQuitPromise;
}

function applicationMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Show Confuse", click: showMainWindow },
        { label: "Quit UI", click: quitUi },
        {
          label: "Quit Confuse",
          accelerator: "CmdOrCtrl+Q",
          click: () => void quitConfuse(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Confuse");
  tray.setToolTip("Confuse");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Confuse", click: showMainWindow },
      { type: "separator" },
      { label: "Quit UI", click: quitUi },
      { label: "Quit Confuse", click: () => void quitConfuse() },
    ]),
  );
  tray.on("click", showMainWindow);
}

async function refreshState(): Promise<void> {
  if (!client) {
    return;
  }
  try {
    updateState(await client.request("desktop.get-state", undefined));
  } catch {
    // The current URL continues to retry while launchd starts the supervisor.
  }
}

function installSupervisorBridge(): void {
  client = new SupervisorClient(supervisorSocketPath());
  client.onConnected(() => void refreshState());
  client.onEvent("desktop.state-changed", (state) => {
    broadcastEvent("desktop.state-changed", state);
    updateState(state);
  });
  client.onEvent("desktop.job-changed", (job) => {
    broadcastEvent("desktop.job-changed", job);
  });
  client.onEvent("desktop.notification-created", (notification) => {
    broadcastEvent("desktop.notification-created", notification);
    showSystemNotification(notification);
  });

  ipcMain.handle("confuse:invoke", async (event, message: unknown) => {
    if (!client || !isTrustedSender(event)) {
      throw new Error("Rejected desktop IPC sender");
    }
    if (!message || typeof message !== "object") {
      throw new Error("Invalid desktop IPC request");
    }
    const { channel, request } = message as {
      channel?: DesktopChannel;
      request?: unknown;
    };
    if (!channel || !desktopChannels.has(channel)) {
      throw new Error("Unsupported desktop IPC channel");
    }
    if (channel === "desktop.quit") {
      await quitConfuse();
      if (quitMode !== "full") {
        throw new Error("Confuse did not complete its full quit");
      }
      return;
    }
    return client.request(channel, request as never);
  });

  client.start();
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(applicationMenu());
  createTray();
  await installAndStartSupervisor();
  installSupervisorBridge();
  createMainWindow();
}

app.setName("Confuse");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("before-quit", () => {
    if (quitMode === "none" || quitMode === "stopping") {
      quitMode = "ui";
    }
  });
  app.on("window-all-closed", () => {
    // Closing or destroying the UI never owns the supervisor lifecycle.
  });
  app.on("will-quit", () => client?.close());
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox(
        "Confuse failed to start",
        error instanceof Error ? error.message : String(error),
      );
      quitUi();
    });
}
