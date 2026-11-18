# ADR 047: Updating Claude Code from the app

- Status: Accepted
- Date: 2026-11-18
- Decision owners: Wisp maintainer, backend and server
- Scope: How the person updates the `claude` that Claude Code Wisps run on,
  on this computer or on a server
- Related: [ADR 017](017-container-execution.md),
  [ADR 026](026-claude-code-runtime.md#version-compatibility),
  [models guide](../models.md#claude-code), SWE-337

## Context

Claude Code Wisps run on the `claude` installed on the server's computer
([ADR 026](026-claude-code-runtime.md)). Each Wisp release ships an Agent SDK
built for a Claude Code version, and an older `claude` makes the provider
unavailable until someone runs `claude update` there. On a headless server,
such as a Raspberry Pi, that means opening SSH for a one-line fix, and until
then every Claude Code Wisp stops answering.

`claude` can be installed several ways, and each can only be updated by its
own installer. Running the wrong one breaks it: `claude update` on an npm
install, or `npm install -g` with the `npm` of another Node, leaves a second
copy that `PATH` may or may not pick. T3 Code solves this by updating only
installs whose path proves the installer, and showing the command otherwise.

## Decision

**The person can update `claude` from **Settings → Providers → Claude Code**.
The server runs the installer that its path proves owns it, with a fixed
command; any other install shows the command to run instead.**

- **Which installer.** The path of the `claude` the status check found, with
  symlinks followed, decides it:
  - **Native:** a path under `…/claude/versions/` (the native installer's
    `~/.local/share/claude/versions/`), or `~/.local/bin/claude.exe` on
    Windows, runs `claude update`.
  - **npm:** `<prefix>/lib/node_modules/@anthropic-ai/claude-code/` runs
    `npm install --global --prefix <prefix> @anthropic-ai/claude-code@latest`
    with the prefix's own `npm` when it has one. The prefix is pinned because
    the `npm` on `PATH` may belong to another Node. A prefix the server's
    user cannot write, such as `/usr/lib`, is manual.
  - **Manual:** anything else. A Homebrew cask shows
    `brew upgrade --cask claude-code`; other installs say to update it the
    way it was installed.
- **Where it runs.** On the server's computer, as the server's user, outside
  any container. It is not a Wisp command
  ([ADR 017](017-container-execution.md)): a Wisp cannot start it, and the
  client sends no command, path, or argument, only the request
  `updateClaudeCode`.
- **When.** One update at a time, and never while a Claude Code turn runs, in
  a chat or a job: **Wait for Wisps on Claude Code to finish before updating
  it.** A process left open between turns does not count; it keeps the
  version it started with, and the next process starts the new one.
- **In the background.** The request returns once the update starts, and
  **Settings → Providers** reloads the view until it ends. A dropped
  connection does not stop it. The native updater downloads a large binary
  without printing progress, and stopping it midway can break `claude`, so
  the limit is 15 minutes.
- **Result.** The status is checked again afterwards. The update succeeded
  only if `claude` answers with a version that is not outdated; an updater
  that exits 0 without updating is reported as a failure. A failure shows
  the last output line that names an error. When the status changes, Wisps
  apply their models again ([ADR 026](026-claude-code-runtime.md)).
- **Where it is offered.** **Settings → Providers → Claude Code** shows
  **Update Claude Code** whenever the install can be updated, as the main
  action while it is outdated. A Wisp whose Claude Code cannot run links to
  it with **Claude Code settings**.

## Consequences

- An outdated `claude` on a headless server is fixed from any client,
  including the browser and a phone, without SSH.
- Installs Wisp cannot prove, and npm prefixes that need root, still need the
  person on the server's computer; the app shows what to run.
- The result of the last update lives in memory: it is gone after the server
  restarts.

## Out of scope

- Updating automatically, or telling that a newer `claude` exists before it
  is required. Both need a version lookup over the network.
- Installing Claude Code where it is missing, and signing it in.
- Homebrew, mise, Volta, pnpm, Bun, WinGet, and Chocolatey installs. T3
  Code's resolver shows how each is proven when one is needed.

## Rejected alternatives

- **Always running `claude update`.** On an npm install it installs a native
  copy elsewhere and leaves the old one first on `PATH`.
- **Running the command the client sends.** The renderer never decides what
  runs on the server ([security](../security.md#renderer-trust-boundary)).
- **Waiting for the update in the request.** A request held for minutes
  fails on slow connections, and a dropped one would leave the result unseen.
