# ADR 045: Confirming server updates

- Status: Accepted
- Date: 2026-11-09
- Decision owners: Wisp maintainer, desktop and server
- Scope: How the desktop app learns how an update of a server it started ended
- Related: [ADR 009](009-headless-server.md), [ADR 044](044-server-archives.md),
  [remote server guide](../remote-server.md#how-an-update-is-confirmed), SWE-111, SWE-313

## Context

The desktop app updates a server by running its `setup` over SSH
([ADR 009](009-headless-server.md)), and took a zero exit followed by a
reconnect as success. That misses several cases:

- The SSH connection drops while the setup runs. The app saw a failure and
  offered to run the setup again, although the update may have finished, or
  still be running.
- The service restarts on the old version, or crashes on the new one, and the
  app reconnects to whatever answers.
- The app quits or restarts during the update and forgets it.
- `npm install` ran over the installed package, so a failed install could
  leave the running server's files half replaced.

## Decision

**Each setup run is recorded on the server, and the desktop app confirms an
update it started only when that record says it completed and the server
answers at the target version.**

- `setup` writes `~/.config/wisp/update.json` atomically at each step:
  `accepted`, `preparing`, `activating`, then `completed` or `failed` with the
  error. A record left unfinished by a process that no longer runs reads as
  `interrupted`. It holds the ID, versions, process ID and times, no
  credentials. An unfinished record of a live process blocks a second setup.
- Before anything the running server uses changes, the setup checks that this
  machine runs the new version (SQLite and PDF rendering), and the npm
  package installs into a staging folder that replaces the old one only once
  complete. After restarting the service, the setup asks the server its
  version and fails when it is not the new one.
- The desktop app passes a UUID as `--update-id` and keeps it with the
  connection until it learns the outcome, across app restarts. When the SSH
  connection drops after the setup started, it reads the record with
  `wispctl update-status --id` over SSH, which only reads, and never runs the
  setup again for a lost answer. After connecting, or failing to, it checks
  the record and the server's version and shows the outcome
  (`ConnectionStatus.update`).
- A failed or interrupted update is reported in the version banner with
  **Update again**. Nothing is retried automatically.
- A server too old to know `update-status` is judged by its version alone.

## Consequences

- An update whose answer was lost no longer looks failed, and is never run
  twice because of it.
- An update that left the old version running is reported as failed even
  though the app reconnected.
- The record describes the last setup only; a later setup run by hand
  replaces it, and the app then judges by the version.
- Restoring the previous version and data when the new one fails to start is
  left to SWE-316.

## Rejected alternatives

- **Asking the server over HTTP.** A server that failed to start cannot
  answer; SSH and the file work whether it runs or not.
- **Retrying the setup when the answer is lost.** The setup restarts the
  service and interrupts Wisps; running it again only because a response was
  lost would do that twice.
