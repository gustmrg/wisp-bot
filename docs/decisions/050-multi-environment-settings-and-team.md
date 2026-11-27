# ADR 050: Multi-environment session pool, settings scope, and team overview

- Status: Accepted (delivered as stacked PRs: B1 session pool and bridge, B2 environment-scoped settings, B3 team overview); partly superseded by [ADR 051](051-unified-environment-sidebar.md), which lists every connected environment in one sidebar, removes `keepLocalRunning` and the sidebar `ConnectionSwitcher`, scopes **Team** to **This computer** or **All environments**, and removes the **Environments** section and **Copy to…** from **Team**
- Date: 2026-11-26
- Decision owners: Wisp desktop main process and renderer
- Scope: Multi-environment session pooling, local background persistence, live operational summaries, and scoped runtime dispatch
- Related: [architecture](../architecture.md), [headless server](../remote-server.md), [ADR 009](009-headless-server.md), [ADR 013](013-ssh-questions.md)

## Context

Previously, `ConnectionManager` held a single `RemoteSession` for the active connection. Switching between **This computer** and a remote Wisp server tore down the current session, stopped the local server child process unless remote access was enabled, and opened a fresh transport from scratch.

This created three problems for people who run Wisps across more than one environment (for example, **This computer** plus a Linux server):

1. **Switching interrupted work on this computer.** Leaving **This computer** stopped its Wisps unless remote access was enabled, even while the desktop app stayed open.
2. **Switching was slow and lost visibility.** Reopening SSH tunnels and event streams on every switch added latency, and the app could not show whether Wisps in another environment were working, waiting for approval, or had unread replies.
3. **Settings and cross-environment views could not inspect another server.** Every `WispApi` call and subscription went only to the active connection, so checking another server's settings or status required switching the whole workspace away from the current conversation.

## Decision

**Keep a pool of `RemoteSession` instances in the desktop main process, keep the local server running in the background by default, track live per-environment summaries, and expose allowlisted cross-environment runtime dispatch.**

The work is delivered in three stacked PRs:

- **PR B1 (this PR): Multi-environment session pool and typed bridge.**
  - `ConnectionStore` persists `keepLocalRunning` in `connections.json`, defaulting to `true` when omitted. On a fresh installation, nothing starts until the person chooses **This computer** or a server.
  - `ConnectionManager` maintains `sessions: Map<string, ManagedSession>` keyed by profile ID alongside `activeId`.
  - Switching away from **This computer** keeps the local server running while `keepLocalRunning` or remote access exposure is enabled, and restarts it if it stops. Disabling `keepLocalRunning` stops the local background session and local server whenever another server is active and remote access is off.
  - Switching to an environment whose pooled session is already connected promotes it immediately without tearing down its transport or tunnel, bumps `status.epoch` so the workspace reloads cleanly, and keeps the previous healthy session in the pool.
  - Already-paired remote servers (and **This computer** when `keepLocalRunning` is on) connect politely in the background after startup or activation. Background sessions always run with `autoPair = false` and non-interactive SSH (`BatchMode=yes`), so they never pop up OpenSSH password, passphrase, or host-key prompts or pair silently.
  - Each pooled session reports an `EnvironmentSummary` (`phase`, `message`, `serverVersion`) from its connection state. It carries no activity counts: the **Team** screen reads each environment's Wisps, statuses, and approvals through `invokeConnectionOperation` instead. `ConnectionsView` exposes `keepLocalRunning` and `environments`.
  - The main process exposes `setKeepLocalRunning`, `connectEnvironment`, `invokeConnectionOperation`, and the pushed `connectionEvent` channel. `invokeConnectionOperation` strictly allowlists only `RUNTIME_OPERATIONS` and validates `connectionId` and `operation` in the main process; desktop-only channels and arbitrary channel strings are rejected.
  - The renderer gains `createEnvironmentApi`, `WispApiProvider`, and `useWispApi` in `src/lib/environment-api.ts`. When targeting the active environment, `createEnvironmentApi` returns the base `WispApi` directly; otherwise it routes runtime operations through `invokeConnectionOperation` and filters `subscribeToConnectionEvents` by `connectionId`.
- **PR B2 (delivered): Environment-scoped settings.**
  - Settings navigation splits cleanly into **App** (device-local: **General**, **Notifications**, **Shortcuts**, **Connections**, **Remote access**, **About**) and **Environment** (**Profile & memory**, **AI Model**, **Providers**, **Voice input**, **Plugins**, **MCP servers**, **Permissions**, **Templates**, **Jobs**, **Storage**, **Token usage**). Passive `SettingsScopeNote` badges are removed.
  - Every Environment panel heading renders `SettingsEnvironmentSelector` when two or more environments exist in the desktop app, showing each profile's icon, name, and live status dot. Selecting another environment changes only what Settings inspects (never calling `activateConnection`), persists across Environment tab switches while Settings stays open, resets to `activeId` on close/reopen, and shows an inline offline card with **Connect** (`connectEnvironment`) and **Open Connections** when the target environment is disconnected or unpaired.
  - All Environment panels and helper hooks use `useWispApi()` inside `WispApiProvider` keyed on `selectedEnvironmentId`, reusing active workspace props when targeting `activeId` and loading target environment Wisps, conversations, profile, and tool policy via scoped runtime operations otherwise.
  - **Templates** adds **Copy to…** on saved templates when two or more environments are connected, copying only the credential-free, grant-free template definition (`access` stripped).
  - **Settings → Connections** exposes **Keep this computer's Wisps running in the background** (`setKeepLocalRunning`) when two or more environments exist.
- **PR B3 (delivered): Team overview and multi-environment sidebar.**
  - The sidebar pins a **Team** navigation item above the conversation list (desktop expanded row, collapsed rail icon with tooltip, and mobile list entry). It shows no status count; pending approvals and working Wisps appear on the **Team** screen itself.
  - Clicking **Team** opens `TeamOverview` in the main workspace panel while keeping the sidebar visible on desktop (and offering clean navigation back to Conversations, Approvals, and Settings on mobile). It provides **New Wisp** and **New circle** actions, search and status/kind filters, a **Waiting for you** approvals section (with direct **Allow once** / **Deny** for standard actions, full **Review** sheet for skills/memory/jobs/Wisp changes, and **Open**), an **Environments** grid when viewing **All environments**, and a **Wisps & circles** directory showing live status, model, and scheduled job counts.
  - Switching from **This environment** to **All environments** loads and subscribes to other connected environments via `createEnvironmentApi` and `subscribeToConnectionEvents` only on demand, keeping background traffic minimal. Selecting a Wisp or approval from another environment switches via `activateConnection` and immediately opens that conversation once the target workspace mounts.
  - Wisp cards offer **Copy to…** when two or more environments are connected, saving only the credential-free, grant-free definition (`name`, `role`, `soul`, `appearance`, `color`, `skills`) as a Wisp template (ADR 040) into the target environment.
  - `ConnectionSwitcher` displays live per-environment status dots and non-zero badges (`working`, `approvals`, `unread`), shows an aggregate indicator on its trigger when another environment has pending approvals or unread messages, and shows the local-server stop warning only when `keepLocalRunning === false` and remote access is off.
  - The expanded desktop sidebar includes compact **All**, **Working**, and **Unread** filter pills whenever two or more conversations exist, with an empty-filter state and **Show all** reset.

## Security and isolation invariants

- Environments remain strictly isolated in storage, conversations, settings, and credentials. Pooling sessions never copies data or credentials between **This computer** and remote servers.
- `electron/preload.ts` exposes only the frozen, explicitly typed `WispApi` methods (`setKeepLocalRunning`, `connectEnvironment`, `invokeConnectionOperation`, `subscribeToConnectionEvents`), never raw `ipcRenderer` or arbitrary channels.
- `invokeConnectionOperation` enforces the canonical `RUNTIME_OPERATIONS` allowlist in the main process before dispatching.
- Background SSH connections never receive `SshInteraction` and always run in OpenSSH `BatchMode=yes`, preventing unsolicited host-key or credential prompts.
- Leaving an active server closes pending OAuth redirect relays on this computer so an abandoned sign-in cannot complete unexpectedly.

## Consequences

- Switching between connected environments becomes instantaneous without re-establishing SSH tunnels or restarting the local server.
- Local Wisps, scheduled messages, and jobs continue working while the user inspects or chats in a remote environment, unless the user explicitly opts out via `keepLocalRunning: false` (and remote access is off).
- Background servers consume one lightweight SSE stream (and SSH tunnel for SSH profiles) per already-paired profile; wake and network changes probe all pooled sessions via `checkConnection()`, and quitting the app cleanly stops every pooled session and the local server.
- Existing tests and clients that expect `ConnectionsView` without the new fields remain compatible because `keepLocalRunning` and `environments` are optional on `ConnectionsView` (and always populated by `ConnectionManager`).

## Rejected alternatives

- **Opening a fresh one-shot HTTP client per Settings panel or Team card.** Duplicates authentication, token refresh, and SSH tunnel lifecycle, and cannot stream live operational counts without reopening SSE streams.
- **Exposing raw IPC channel dispatch from preload.** Violates the renderer trust boundary in [security](../security.md); allowlisting `RUNTIME_OPERATIONS` in the main process keeps desktop-only channels unreachable through `invokeConnectionOperation`.
- **Running interactive SSH prompts for background connections.** Would interrupt the user with unexpected host-key or passphrase dialogs for servers they did not just select.
