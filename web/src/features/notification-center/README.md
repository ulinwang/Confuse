# Notification center

## Surface

Desktop-only persistent notifications and background job progress. The sidebar entry opens a left Sheet; the daemon remains the source of truth.

## Entry Points

- `NotificationCenter.tsx` is mounted by both classic and next sidebar footers.
- `bridge.ts` is also consumed by desktop onboarding for runtime detection and Agent labels.

## Structure

- `confuse.d.ts` mirrors the renderer-safe contracts in `desktop/src/shared/contracts.ts` and declares `window.confuse`.
- `desktopStore.ts` owns IPC loading, event subscriptions, read state actions, and retries.
- `NotificationCenter.tsx` owns Sheet visibility and view-only job/notification rendering.

## External Consumers

`AuthenticatedLayout` subscribes to `firstRunComplete` through `desktopStore.ts`. Desktop onboarding calls `refresh()` after scheduling background work.

## State Ownership

Persistent jobs and notifications live in the daemon. `desktopStore.ts` is the cross-route browser replica and merges live events with in-flight loads; Sheet open state is local to `NotificationCenter` and the `notificationCenter=open` query opens it. Selection state belongs to desktop onboarding, not this feature.

## Performance And Stability Boundaries

Job events rerender the mounted notification center only. `AuthenticatedLayout` subscribes to the primitive first-run value rather than the full snapshot. There are no virtualized or high-frequency pointer interactions.

## Migration State

The current shape centralizes all IPC integration in the external store. If notification volume becomes large, split the trigger's unread-count subscription from the Sheet body and virtualize the list.

## Development Context

Keep changes aligned with `desktop/src/shared/contracts.ts`. Read `web/AGENTS.md` and the frontend large-feature architecture skill before extending the store or overlays.
