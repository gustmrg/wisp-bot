# ADR 027: Runtime-neutral names for the Wisp storage folders

- Status: Accepted
- Date: 2026-10-19
- Decision owners: Wisp maintainer, backend
- Scope: The names of the per-Wisp and per-session folders in the backend
  data directory, and how existing data moves to the new names
- Related: [ADR 001](001-agent-runtime.md), [ADR 010](010-wisp-entity.md),
  [ADR 026](026-claude-code-runtime.md)

## Context

[ADR 010](010-wisp-entity.md) ("Folders follow their owner") puts each kind of
data in the folder of whoever owns it:

| Belongs to | Folder | Holds |
|---|---|---|
| The Wisp | `pi-config/<Wisp storage ID>` | Skills, saved memory, context settings, Pi settings |
| The conversation | `workspaces/<conversation storage ID>` | Files the Wisps in it work on |
| A Wisp in a conversation | `pi-sessions/<session ID>` | That Wisp's agent history there |

The ownership rule still holds. The names do not: they were chosen when Pi was
the only runtime, and two of the three say "Pi".

Pi does not require them. Left alone, Pi keeps its files in `~/.pi/agent/`
(settings, `sessions/`). Wisp chose `pi-config` and `pi-sessions` and hands
them to Pi: `agentDir: context.configDirectory` and the session directory
passed to `SessionManager` (`backend/pi-conversation-agent.ts`). Renaming the
folders needs no change on Pi's side.

[ADR 026](026-claude-code-runtime.md) made Claude Code a second runtime. It
put its data in the existing "Wisp in a conversation" folder, which is the
right owner, and did not touch the names. The result:

- `pi-sessions/<session ID>/claude-code-session.json` and
  `claude-code-usage.jsonl` sit in a folder named after another runtime.
- `pi-config/<Wisp>/context-settings.json`, the skills and the saved memory
  apply to a Wisp whichever runtime answers, but live under "pi".
- The name misleads anyone reading the data directory, a backup, or the code
  (`sessionRoot`, `configRoot`, the archive step for deleted Wisps).

Only two production files spell the names (`backend/conversation-repository.ts`
and `server/backup.ts`); everything else reaches the folders through
`configDirectory` and `sessionDirectory`. Two stored values do contain them:

- `participant_sessions.pi_session_file` holds an absolute path. The
  repository already re-anchors a path that is not under the session's folder
  by its file name when it loads (`relocatedPiSessionFile`, written for
  restored backups), so a stale value resolves to the right file.
- `job_runs.session_file` holds an absolute path too, but nothing re-anchors
  it. It is only used to delete a run's file once the run is pruned, and that
  deletion refuses any path outside the session folders. A stale value would
  leave the file on disk for good.

## Decision

**Rename the two folders to runtime-neutral names, once, when the data
directory loads, and record it in the conversation store's version.**

| Before | After |
|---|---|
| `pi-config/<Wisp storage ID>` | `wisp-config/<Wisp storage ID>` |
| `pi-sessions/<session ID>` | `wisp-sessions/<session ID>` |
| `workspaces/<conversation storage ID>` | unchanged |

Only the first level changes. Storage IDs, session IDs, and every file inside
keep their names, so Pi's own files and Claude Code's
(`claude-code-session.json`, `claude-code-usage.jsonl`, `claude-code-fallback/`)
are not renamed. A deleted Wisp's archive uses the same words
(`wisp-config`, `wisp-session`); archives already made keep theirs, and nothing
reads those names back.

Claude Code's own transcripts under `~/.claude/projects/` are not part of this
change. [ADR 026](026-claude-code-runtime.md) keeps them out of Wisp's data on
purpose, and they are keyed by the **workspace** path, which does not change.

### Migration

`ConversationRepository.load()` runs it before it opens the store, because
loading creates the folders under their new names and would otherwise leave an
empty `wisp-config/<id>` where the old folder has to go.

1. **Move the folders.** One `rename` for each, inside the data directory, so
   it is atomic and costs nothing however large the sessions are. A folder
   already moved, or a data directory that never had the old one, is skipped,
   so a start interrupted between the two moves finishes on the next one.
2. **Upgrade the store to version 12.** The store backs itself up first, as it
   does before every upgrade (`conversations.sqlite.v11.backup`), then renames
   the session folder in each `job_runs.session_file` and raises both version
   markers in one transaction. The step also runs for any run still under the
   old name, so an interrupted upgrade is finished.

Both old and new folder present is not merged. An old folder that is empty is
removed; one with data stops startup with a message naming both folders, since
either could hold a Wisp's files and choosing for the person could lose them.

Because it runs when the repository loads, it covers every way a data
directory arrives: the desktop app, the dev data directory, a server, and a
restored backup. Each environment migrates its own directory on its first start
with this version; nothing moves between computers.

### Downgrades

Version 12 raises `min_reader_version` to 12. A build from before this change
refuses the database ("saved by a newer version of Wisp Bot") instead of
starting with its old folder names missing and every Wisp appearing to have
lost its skills, memory and history. Going back means installing this version
again, or restoring `conversations.sqlite.v11.backup` **and** renaming the two
folders back by hand.

Betas share the database with stable releases, so a beta built before this
change cannot open a data directory this version migrated. That is the cost of
a layout change and is accepted.

### Backups

`server/backup.ts` skips `wisp-config/<Wisp>/transcription-cache` instead of
the old path. A backup holds the layout of the environment that made it; one
made before this change restores with the old names and is migrated when the
restored directory first loads.

## Alternatives considered

- **Leave the names and document them.** Zero risk, and the ownership rule is
  what ADR 010 decided, but every future runtime repeats the confusion.
- **Rename only for new installs.** Two layouts forever, and every code path
  that builds a path has to ask which one it is on.
- **Leave a symlink at the old name.** Backups neither follow nor copy links,
  and they behave differently on Windows.
- **A folder per runtime** (`pi-sessions/` and `claude-code-sessions/`).
  Splits one Wisp's history across folders and breaks "a Wisp in a
  conversation" as the unit; a runtime switch would have to move data.
- **Move to `workspaces/<id>/.wisp/`.** Mixes app state into a folder the
  Wisp's own tools can read and write, which the container and file tools are
  built to avoid.
- **Re-anchor job run files when they are read**, as session files are, and
  skip the store version. Less code, but the old paths stay in the database
  for good and an older build still opens it and finds no folders.
- **Merge two folders that both hold data.** A guess about which side wins
  can destroy a Wisp's history; stopping with a message cannot.

## Consequences

- The data directory reads the same whichever runtime a Wisp uses, and a third
  runtime needs no new folder name.
- One more store version, and a startup step that does nothing once the
  folders have their new names. [ADR 036](036-upgrade-floor.md) removed the
  step: every data directory it opens already has the new names.
- Older ADRs still say `pi-config` and `pi-sessions`. They stay as written;
  they record what was decided then. [ADR 010](010-wisp-entity.md) gets a note
  pointing here.
- The change touches no file the Claude Code runtime needs, so it can merge
  before or after [ADR 026](026-claude-code-runtime.md) in a pull request of
  its own.

## Verification

Tests run against temporary data directories, never a real one:

- the folder move: nothing to do, both folders, one already moved and a
  repeat, an empty old folder beside a new one, and both holding data;
- the store: a version 11 store gets its job run files renamed (POSIX and
  Windows separators), a `.v11.backup`, the new markers, and is refused by a
  reader that predates it; runs left under the old name are finished;
- the repository: an old-layout directory loads with its Wisps' files and a
  stored session file that resolves under the new folder;
- the backup skips `transcription-cache` under `wisp-config`, and the archive
  of a deleted Wisp uses the new words.

The migration was also run on a copy of the maintainer's own data directory:
both folders moved, the stored session file resolved, and the store went to
version 12 with a `.v11.backup`.
