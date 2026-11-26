# ADR 051: One conversation list across connected environments

- Status: Accepted
- Date: 2026-11-26
- Decision owners: Wisp desktop main process and renderer
- Scope: The sidebar, **Team**, the create dialog, and the local server's lifetime when several environments are connected
- Related: [ADR 050](050-multi-environment-settings-and-team.md), [headless server](../remote-server.md), [architecture](../architecture.md)

## Context

ADR 050 kept every connected environment live in a session pool, but the
desktop app still showed one environment at a time. The person picked it in a
sidebar switcher, and the conversation list, **Team**'s **This environment**,
and the create dialog all followed that choice. Someone with **This computer**
and a Raspberry Pi had to remember where each Wisp lived and switch before
opening it.

Three things stood in the way of a single list:

1. Most of the renderer calls `window.wisp` directly, which always targets the
   active environment, and `ConnectionGate` remounts the whole app when it
   changes.
2. A remount re-ran the setup gate and the opening splash, so a switch looked
   like a restart.
3. **Keep this computer's Wisps running in the background** could stop the
   local server whenever a server was active, which would make **This
   computer**'s conversations vanish from a shared list.

## Decision

**List every connected environment's conversations together and switch the
active environment implicitly when one is opened.** The active environment
stays an internal detail: the workspace still talks to one environment at a
time (option A), shaped so a later per-conversation workspace (option B) can
reuse the same pieces.

- `EnvironmentDirectoryProvider` (`src/features/environments/`) sits in
  `ConnectionGate` above the keyed app, so it survives switches. With two or
  more environments it loads each connected one with a single
  `getConversationState`, keeps it live from `subscribeToConnectionEvents`, keeps
  a reconnecting environment's last state (shown dimmed), loads it again once it
  reconnects, and drops it when it disconnects. It never fetches models or jobs.
- The sidebar lists the active environment's conversations with every other
  environment's, keyed by environment and conversation ID, since IDs are only
  unique within an environment. Rows from a server show its name. Opening one
  calls `openEnvironmentChat`, which records the conversation and activates its
  environment; the remounted workspace opens it. Pin, mute, and read actions go
  straight to that environment through `createEnvironmentApi`.
- The sidebar no longer has a connection switcher. Servers are managed in
  **Settings → Connections**.
- A remount after the first opening skips the setup gate and the splash, and
  keeps the sidebar's filter and scroll position (`workspace-memory.ts`). An
  environment without a model says so in its conversations instead of
  onboarding again. Opening a server that was already connected shows no
  **Connected to** notice.
- If the server in use fails for good (phase `error` after being connected)
  while **This computer** runs, the app activates **This computer** and says
  which server stopped working, instead of covering every conversation with the
  connection screen.
- **This computer**'s server always runs once the person has chosen where Wisps
  run. `keepLocalRunning`, `setKeepLocalRunning`, and its setting are removed;
  older `connections.json` files with the field still load.
- **Team**'s scopes are **This computer** and **All environments**, whatever
  environment is in use. Environment cards no longer offer **Switch to**, and
  Wisp cards no longer offer **Copy to…**. Model names and job counts still load
  only for the environments in scope.
- **New Wisp** and **New circle** ask where to create, **This computer** first,
  listing only connected environments. A Wisp or circle created elsewhere is
  created through that environment's scoped API, its setup and template choices
  go to the same environment, and it opens there once the dialog closes. A
  circle only gathers Wisps of its own environment.

## Security and isolation invariants

- Nothing is copied between environments. The directory only reads what each
  environment already sends this app, and every write names its environment.
- Scoped calls still go through `invokeConnectionOperation`, which allows only
  `RUNTIME_OPERATIONS` and checks the connection in the main process.
- The browser app has one environment, so nothing here changes it.

## Consequences

- One list shows every Wisp and circle from connected environments, and opening
  any of them is one click.
- Opening a conversation of another environment still remounts the workspace.
  The list, its filter, and drafts stay; the main panel reloads.
- Each connected environment costs one `getConversationState` when it connects,
  on top of the summary ADR 050 already keeps.
- **This computer** runs its server whenever another environment is in use.
- Search, the phone **Approvals** tab, system notifications, sounds, and the
  profile at the bottom of the sidebar still cover only the environment in use.

## Rejected alternatives

- **A workspace with no active environment (option B).** It is the cleaner
  model, but it means moving `use-conversations`, the chat panel, queues,
  scheduled messages, approvals, and notifications to per-conversation APIs at
  once. The directory, composite keys, and scoped create dialog are the parts it
  would reuse.
- **Keeping the switcher next to the shared list.** Two ways to reach the same
  conversation, and the switcher's choice would no longer decide what is shown.
- **Falling back to the first connected environment when This computer is not
  running.** With its server always running after the first choice, this only
  covers a short restart, which the dialog and **Team** show as starting.
