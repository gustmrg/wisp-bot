# ADR 036: Upgrade floor at v0.25.3

- Status: Accepted
- Date: 2026-10-29
- Decision owners: Wisp maintainer, backend
- Scope: Which data and settings a build opens, and the upgrade code it keeps
- Related: [ADR 010](010-wisp-entity.md), [ADR 027](027-runtime-neutral-storage-folders.md),
  [ADR 029](029-wisp-memory.md), [architecture](../architecture.md#data-storage)

## Context

Every format change since the first release left an upgrade path in the code,
and each one ran, or was checked, on every start:

- the single-file `conversations.json` store, its record versions 1 to 4, and
  the demo conversations early versions bundled;
- the conversations the renderer kept in local storage before the backend
  stored them, which `initializeConversations` adopted, together with the
  preferences in the same blob;
- a database with records as JSON (layouts before 5) and fourteen in-place
  upgrades, from building the search index to naming reply authors;
- Wisps saved with a shape instead of an appearance, and circles saved
  before each member had a session;
- the `pi-config` and `pi-sessions` folder names ([ADR 027](027-runtime-neutral-storage-folders.md));
- the profile's background and response preferences and each Wisp's saved
  memory, and their one-time import into memory entries ([ADR 029](029-wisp-memory.md));
- credentials encrypted with the keychain directly, the per-Wisp GitHub tokens
  file, and connection settings from before the person chose where Wisps run.

Wisp has one person using it, and every installation, the desktop app and the
server, runs v0.25.3, the latest release. Its database is layout 15.

## Decision

**v0.25.3 is the oldest release whose data a build opens. Code that exists only
to bring older data up to it is removed.**

- The conversation store opens layout 15 or later (`OLDEST_STORE_VERSION`).
  An older database is left in place, and the app refuses to start with a
  message to open it with v0.25.3 first, which upgrades it, as it does for a
  database a newer version wrote.
- A new store is created in the current layout. `initializeConversations`
  takes no conversations: it marks a new environment's store as set up, with
  none.
- Settings files are read leniently instead of upgraded: keys a build no longer
  knows, such as the profile's old fields or a Wisp's saved memory, are left
  out and dropped the next time the file is saved.
- The next upgrade raises `STORE_VERSION` as before and backs the database up
  first. `OLDEST_STORE_VERSION` rises only with a decision like this one.

## Consequences

- Startup no longer looks for `conversations.json`, old folder names, or
  keychain credentials, and the store opens without checking each upgrade.
- Data from before v0.25.3 needs v0.25.3 once. This computer's data in the
  desktop app counts: if it was last opened by an older version, switch to
  **This computer** once in v0.25.3 before updating.
- Tests seed conversations through the repository (`seedConversations`)
  instead of the local-storage import.

## Deferred

- Client and server fallbacks for servers older than v0.25.3, and the
  `unread` flag kept beside `unreadCount` for older clients.
- Moving the per-Wisp settings files, such as `context-settings.json`, into
  the database.

## Decisions taken with the user

- The floor is the latest release, v0.25.3, and its database layout.
- No compatibility with data or settings from earlier versions is kept.

## Rejected alternatives

- **Keep the upgrades and stop adding new ones.** Every start would still pay
  for checks that never apply, and the code would keep paths no one can test
  against real data.
- **A floor at layout 12**, the oldest layout older readers may still write.
  It keeps half the upgrades for data that no installation has.
