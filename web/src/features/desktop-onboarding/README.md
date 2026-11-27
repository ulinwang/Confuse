# Desktop onboarding

## Flow

1. `OrganizationStep` creates the desktop organization before any Agent project.
2. `DesktopOnboardingWizard` loads only installation metadata and desktop state. New Agents are unselected by default; existing connected Agents stay selected. History remains opt-in.
3. Review and privacy confirmation enqueue per-Agent connection work. Each Agent receives its own Langfuse project and Keychain-scoped credentials.
4. Notifications link to the corresponding project Session page without exposing credentials.

Legacy connections without an organization require this upgrade flow. Startup never creates an organization, projects, or history imports automatically.

## Ownership

- `DesktopOnboardingWizard.tsx`: scan state, selections, history preview, and workflow actions.
- `OrganizationStep.tsx`: organization name and creation confirmation.
- `CleanupStep.tsx`: explicit removal of Confuse-managed integrations. It preserves Agent settings, projects, history, Docker volumes, and infrastructure secrets.
- `../desktop/server/*`: loopback-only organization and per-Agent project provisioning with the desktop bearer token.
- `desktop/src/supervisor/agent-projects.ts`: organization/project registry, secret storage, project-scoped SDK options, and revocation.
- `desktop/src/supervisor/history/*`: project-scoped history cursors and migration from the legacy default project.

Cleanup is not a normal quit. The desktop shell stops background jobs and delivery before disconnecting managed Agent blocks, revoking Agent keys, stopping Compose, removing the LaunchAgent, and deleting desktop/Agent credentials. Deleting `Confuse.app` without this flow cannot remove those integrations.

## Verification

- `DesktopOnboardingWizard.clienttest.tsx`: organization-before-Agent ordering, default-minimal selection, history opt-in, and the distinct cleanup flow.
- `desktop/src/supervisor/agent-projects.test.ts`: project isolation, reuse, missing-organization rejection, credential preservation, and revocation.
- `desktop/src/supervisor/runtime-integration.test.ts`: organization-required protocol and removal of only Confuse-managed files across all four Agent homes.
- `web/src/__tests__/server/unit/desktop-{organization,projects}.servertest.ts`: loopback authentication, owner scoping, per-Agent credentials, cross-tenant rejection, and idempotent legacy cleanup.
