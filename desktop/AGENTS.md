# Confuse desktop

## Scope

Electron shell, local supervisor, macOS LaunchAgent resources, Agent connectors, history import, and desktop packaging.

## Architecture

- `src/main/`: Electron lifecycle, tray, navigation restrictions, and IPC client.
- `src/preload/`: context-isolated bridge exposed as `window.confuse`.
- `src/supervisor/`: standalone Node 24 foreground daemon, local persistence, Compose lifecycle, Agent adapters, SDK outbox.
- `src/shared/`: dependency-free TypeScript contracts imported by desktop processes only.
- `resources/`: Compose, LaunchAgent templates, and bundled assets.

## Rules

- Never execute renderer-provided shell strings. Spawn fixed executables with argument arrays.
- The supervisor is the only writer of desktop state. Keep SDK keys in Keychain and out of renderer responses, logs, and notifications.
- Discovery must not read credentials or session bodies. History reads require an explicit per-Agent selection.
- Tests use temporary homes and synthetic sessions, never the user's real Agent configuration or history.
- Close-window, UI-only exit, and full quit are distinct behaviors. Full quit stops only the `confuse` Compose project and never removes volumes.
- Create the desktop organization before any Agent project or configuration write. Existing connections without that organization require an explicit upgrade choice; never create projects or import history automatically at startup.
- Uninstall is an explicit separate action, not a full quit. Limit cleanup to Confuse-managed hooks, forwarding scripts, per-Agent credentials, and the LaunchAgent. Preserve Agent settings, history, Langfuse projects, volumes, and infrastructure secrets.
- Build outputs and packaged apps are ignored generated artifacts.
