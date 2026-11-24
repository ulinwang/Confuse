# Desktop onboarding

## Surface

First-run and manually reopened desktop Agent setup. Users choose among four discovered Agents, opt into history per Agent, review the configuration and privacy scope, then schedule daemon work in the background.

## Entry Points

- `DesktopOnboardingModal.tsx` is mounted by `AuthenticatedLayout` only when the desktop bridge exists and `firstRunComplete` is false.
- `DesktopOnboardingPage.tsx` backs `/desktop-onboarding` for manual reopening and a non-desktop explanatory state.

## Structure

- `DesktopOnboardingWizard.tsx` owns IPC discovery, loaded-data gating, selection state, preview, and submission.
- Modal and page wrappers own dismissal/navigation; the wizard owns neither.

## External Consumers

The classic and next sidebars link here through the notification center. `AuthenticatedLayout` adds a desktop-only account settings link.

## State Ownership

Discovered Agents and previews come from IPC. The inner form seeds selection state only after discovery resolves; history always starts false. Completion and task progress remain in the daemon and notification-center store.

## Performance And Stability Boundaries

Discovery runs once per wizard mount or explicit retry. Selection changes rerender only the wizard, not the application shell. No high-frequency subscriptions live in this feature.

## Migration State

The current shape separates loaded-data preparation from editable form state. If manual config-path selection is added, keep it in the selection model and include only metadata in any future analytics.

## Development Context

Keep renderer types aligned with `desktop/src/shared/contracts.ts`. Discovery must not read credentials or session bodies; history access requires an explicit per-Agent choice.
