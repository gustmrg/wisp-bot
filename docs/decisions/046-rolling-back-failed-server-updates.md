# ADR 046: Rolling back server updates that fail before activation

- Status: Accepted
- Date: 2026-11-09
- Decision owners: Wisp maintainer, server and backend
- Scope: What happens to a server's data and version when a new version
  cannot start on it
- Related: [ADR 036](036-upgrade-floor.md), [ADR 044](044-server-archives.md),
  [ADR 045](045-confirming-server-updates.md),
  [remote server guide](../remote-server.md#when-an-update-fails-to-start), SWE-316

## Context

A new server version upgrades the databases as it starts. If it then fails,
going back to the previous version does not undo the upgrade, and the
previous version may refuse data a newer one wrote. The conversation
database keeps a copy before each upgrade (`.v<N>.backup`), but nothing puts
it back, and `server.sqlite` and the settings files beside the database
change too.

The backend also starts work as soon as it is composed: it restores the
agents, marks unanswered requests failed, sends queued and scheduled
messages, starts jobs, reconciles containers and refreshes model catalogs. A
version tried on the data must not do any of that before it is accepted.

## Decision

**An update from one server archive to another is a transaction over the
data directory, with an explicit activation boundary: the new version opens
and upgrades the data without starting anything, and only if that works is
it activated; otherwise the data and the previous version are restored.**

- **Activation boundary.** `createBackendRuntime` composes every service, then
  activates them. `prepareBackendData` composes the same services and only
  opens the stored data (`ConversationRepository.load`, which runs the
  database upgrades), then disposes them; it fails when the database had to be
  set aside as unreadable. `prepareServerData` adds `server.sqlite`.
  Everything fallible at startup runs there; agents, messages, jobs,
  containers and network refreshes start only on activation.
- **Coverage.** The snapshot holds `server.sqlite` and
  `backend/conversations.sqlite` with their `-wal` and `-shm` files, and the
  `.json` files directly in `backend/`. Restoring removes covered files the
  snapshot does not hold. Workspaces, agent sessions, logs, the tool audit
  log, containers and external effects are not covered and are documented as
  such.
- **Transaction.** The setup checks free space for the snapshot before
  stopping anything, stops the service, and takes the data directory's lock
  to snapshot. The new version's `wispctl prepare-data` runs in its own
  process, holding the lock, with a 10-minute limit. On success, `current`
  moves to the new version and the transaction commits, in that order; on
  failure the snapshot is restored under the lock, the previous version starts
  again, and the update record says `rolled-back` with the reason.
- **Durable state.** `.update-transaction.json` in the data directory records
  the step: snapshotting, trying or restoring, written and synced before each
  step. Whoever opens the data directory next with its lock, the next setup
  or any server start (`createWispServer`), finishes it first: a snapshot in
  progress is dropped, a trial or restore in progress is rolled back.
- **One writer.** Only the holder of the data directory's lock touches the
  data: the setup while it snapshots and restores, the trial while it
  prepares, the server while it runs.

## Consequences

- A version that cannot open the data no longer leaves a server down or its
  data half upgraded; the person sees the reason and **Update again**.
- An update briefly needs free space for a copy of the databases and settings.
- Recovery runs in whichever version starts next, so it protects updates
  from a version that has this code. The first update from an older server
  has only the activation boundary of the new version.
- A server installed from npm, and the move from npm to an archive, update
  without a transaction.

## Out of scope

- Rolling back after activation, once the new version runs and may have
  accepted changes, and downgrading on request.
- Undoing what systems outside the server already accepted.

## Rejected alternatives

- **A supervisor process that outlives versions**, as T3 Code's launcher.
  It covers crashes after activation too, but adds a process that runs at all
  times and an IPC protocol every version must keep. Updates only happen
  through the setup, which can hold the transaction itself.
- **Restoring only the conversation database's `.v<N>.backup`.** It misses
  `server.sqlite` and the settings files, and the backup is taken by the new
  version, after it decided to upgrade.
- **Running the trial in the setup's own process.** A trial that hangs could
  not be stopped, and a crash in it would take the setup down with it.
