# Confuse desktop

Confuse uses an Electron UI and a separate Node 24 supervisor. The supervisor owns Docker Compose, local state, Agent configuration, and history import. Electron never executes renderer-provided commands and never writes desktop state directly.

## Development

From the repository root, after workspace dependencies are installed:

```sh
pnpm --filter @confuse/desktop dev
```

The development command builds `confuse-web:local` and `confuse-worker:local`, compiles `src/`, and starts Electron with those local image names and `NODE_ENV=development`. Docker must be available for the image builds. The command does not start Compose services or the supervisor; the app starts them through its normal lifecycle.

Environment variables:

| Variable                    | Default                                   | Purpose                                                                  |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `CONFUSE_SUPERVISOR_SOCKET` | `app.getPath("userData")/supervisor.sock` | Supervisor Unix domain socket                                            |
| `CONFUSE_SOCKET_PATH`       | Unset                                     | Legacy alias for the socket path                                         |
| `CONFUSE_DEV_WEB_URL`       | `http://127.0.0.1:3000`                   | Web URL in development                                                   |
| `CONFUSE_WEB_URL`           | `http://127.0.0.1:3000`                   | Fallback Web URL; also used in production until supervisor state arrives |

Web URLs must use HTTP(S) on `127.0.0.1`, `localhost`, or `::1`, without URL credentials. Once connected, `desktop.get-state` and `desktop.state-changed` supply the supervisor's `webUrl`.

The supervisor must implement the newline-delimited JSON protocol in `src/shared/protocol.ts`. Its socket must be user-only (`0600`) inside a `0700` directory. `desktop.quit` must stop only the Confuse Compose project and return after the stop completes; it must not remove volumes or stop Docker Desktop.

## UI and process lifecycle

- Closing the window hides it. The supervisor and containers continue running.
- **Quit UI** exits only Electron. LaunchAgent and local services continue running.
- **Quit Confuse** sends `desktop.quit` and exits Electron only after the supervisor confirms success. A failed request leaves the UI available and reports that services are still running.
- The Tray and application menu expose all three actions. macOS notifications supplement persisted renderer notifications; clicking one reopens the UI and follows only a same-local-origin route.

The BrowserWindow uses context isolation, sandboxing, no Node integration, denied renderer permissions, and a narrow `window.confuse` bridge. IPC is limited to contract channels and accepted only from the main frame of the current local Web origin. New windows are denied; HTTPS and `mailto:` links open in the system browser.

## Build and DMG

```sh
pnpm --filter @confuse/desktop typecheck
pnpm --filter @confuse/desktop test
pnpm --filter @confuse/desktop build
pnpm --filter @confuse/desktop make
```

`package`, `make`, and `make:mac` do not build Docker images. Packaged Compose defaults to `ghcr.io/ulinwang/confuse-web:0.1.0` and `ghcr.io/ulinwang/confuse-worker:0.1.0`; Docker pulls them when the supervisor starts the six-service project. Published ports remain bound to loopback and application volumes are preserved on shutdown.

To rebuild local development images without starting Electron:

```sh
pnpm --filter @confuse/desktop run build:images
```

To publish both images for Linux AMD64 and ARM64, authenticate to GHCR with a token that can write packages, then explicitly select push mode. The tag defaults to `desktop/package.json`'s version and can be set explicitly:

```sh
pnpm --filter @confuse/desktop run build:images -- --push --tag 0.1.0
```

The release workflow uses the repository's `packages: write` permission to PATCH both `confuse-web` and `confuse-worker` to `public` after the first push, then verifies anonymous manifest access and both Linux architectures. A failed PATCH or anonymous check stops the workflow before DMG creation and before any GitHub release.

`make` builds a DMG for the host architecture. To request both macOS architectures:

```sh
pnpm --filter @confuse/desktop make:mac
```

`make:mac` clears prior Forge maker output, builds ARM64 first and x64 second, and verifies that the only DMGs are `Confuse-<version>-arm64.dmg` and `Confuse-<version>-x64.dmg`. The architecture-specific names prevent one build from overwriting the other.

Artifacts are written under `desktop/out/`. `desktop/resources/`, when present, is copied to the app's resources directory. Compiled `dist/`, runtime `node_modules/`, and `resources/` are also unpacked from ASAR so a LaunchAgent can run `app.asar.unpacked/dist/supervisor/index.mjs` with Electron's bundled Node 24 runtime and resolve `app.asar.unpacked/resources/compose.yml`; the LaunchAgent template must not try to execute code inside `app.asar`.

## Signing and notarization

Unsigned local builds are the default. Signing with Hardened Runtime and notarization are enabled together only when all of these variables are present:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_ID_PASSWORD` (an app-specific password)
- `APPLE_TEAM_ID`

The Forge configuration uses `notarytool`. Stapling and release verification remain release-pipeline steps. An incomplete credential set produces an unsigned build; validate only that unsigned artifact and do not describe it as signed, notarized, stapled, or formally released.

The LaunchAgent receives only the resolved Web/worker image names, Web/MinIO ports, and resource directory, in addition to its fixed supervisor paths and `ELECTRON_RUN_AS_NODE`. Database credentials, project keys, and the desktop authentication token are never copied into its plist; they remain in Keychain and are supplied only to the Compose child environment.

## Release workflow

`.github/workflows/desktop-release.yml` runs for `desktop-v*` tags and manual dispatches. The version must match both `desktop/package.json` and the Compose defaults. It pushes and publicly verifies the Web and worker images, runs desktop tests, builds and validates exactly one ARM64 and one x64 macOS DMG, and uploads workflow artifacts. Only a complete Apple signing and notarization credential set enables the separate GitHub release job. Manual dispatches create the release tag at the dispatched commit when necessary.

The workflow uses the repository's scoped `github.token` for image pushes, package visibility updates, and signed releases. It does not use Langfuse deployment or other upstream service secrets. When any `APPLE_*` secret described above is absent, it uploads `desktop-dmg-unsigned-<version>` with an explicit `UNSIGNED CI ARTIFACT` marker and does not create or update a GitHub release.
