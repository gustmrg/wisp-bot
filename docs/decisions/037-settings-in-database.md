# ADR 037: Settings live in the database

- Status: Proposed
- Date: 2026-10-29
- Decision owners: Wisp maintainer, backend
- Scope: Where an environment stores its settings, and which JSON files stay files
- Related: [ADR 010](010-wisp-entity.md), [ADR 029](029-wisp-memory.md),
  [ADR 036](036-upgrade-floor.md), [architecture](../architecture.md#data-storage)

## Context

Conversations, Wisps, jobs and memory live in `conversations.sqlite`, but each
environment still keeps its settings in JSON files beside it, each with its own
store, validation and atomic write:

- for the whole environment: `user-profile.json`, `user-time-zone.json`,
  `ai-settings.json`, `tool-policy.json`, `plugins.json` and
  `mcp-servers.json` in `backend/`;
- for each Wisp, in `backend/wisp-config/<storageId>/`:
  `context-settings.json`, `execution-settings.json`,
  `workspace-settings.json` and `tool-policy.json`;
- for each circle: `workspace-settings.json` in
  `backend/circle-config/<storageId>/`.

The files predate the database, when everything was JSON. Now they cost:

- **No transaction across them.** Creating or deleting a Wisp writes its rows
  in one transaction, then creates or moves its settings folder. A crash in
  between leaves a Wisp without settings, or settings without a Wisp.
- **Two ways to fail.** A file that does not parse is renamed aside, a
  database that does not open stops the app; each store handles a missing,
  partial or stale file on its own.
- **Lenient reading instead of versions.** A file has no layout version, so
  each store drops unknown keys and fills defaults on every read
  ([ADR 036](036-upgrade-floor.md)), and a change of shape has nowhere to run
  an upgrade.
- **Backups copy them one by one**, beside a database copied through SQLite's
  backup API, so a backup of a running server can hold settings and rows from
  different moments.
- **Storage and startup walk folders** that exist only to hold one or two
  small files per Wisp.

## Decision

**An environment's settings are rows in `conversations.sqlite`. Files stay
only for what has another owner, its own encryption, or can be rebuilt.**

- Settings move into three tables, each holding one validated JSON document
  per setting name, like message bodies ([ADR 010](010-wisp-entity.md#storage-layout)):
  - `environment_settings (name, value, updated_at)` for the profile, time
    zone, AI model, tool policy, plugins and MCP servers;
  - `wisp_settings (wisp_id, name, value, updated_at)` for context, execution,
    workspace and tool policy, with a foreign key to `wisps` that deletes them
    with the Wisp;
  - `conversation_settings (conversation_id, name, value, updated_at)` for a
    circle's workspace size, with a foreign key to `conversations`.
- A setting is read through the same validator its store uses today. A value
  that does not validate falls back to the defaults and is reported, as a
  damaged file is now.
- The stores keep their interfaces (`AiSettingsStore`, the context, execution
  and workspace settings, `ToolPolicyStore`, the plugin and MCP state) and
  change only where they read and write. Handlers, contracts and the clients do
  not change.
- One upgrade, the next `STORE_VERSION`, imports every settings file into the
  tables in its transaction and removes the files after it commits. It raises
  `MIN_READER_VERSION` to the same layout: v0.25.3 would find no files and run
  with defaults, so it must refuse the database instead.
- Creating, saving and deleting a Wisp or circle writes its settings in the
  same transaction as its rows. A deleted Wisp's settings are deleted with it;
  its archive keeps the workspace, sessions and `MEMORY.md`, which are the
  parts worth keeping.
- `wisp-config/<storageId>/` stays for what is not a setting, such as the
  transcription cache, and is created only when something needs it.

What stays a file:

- **Encrypted credentials** (`credentials.enc.json` and the voice, plugin and
  MCP stores): they are sealed with their own key and kept apart from the data
  on purpose, so a copy of the database holds no secrets.
- **Caches** (`model-catalog.json`, `model-pricing.json`, the transcription
  cache) and **derived files** (`models.json` for Pi, `storage-measurements.json`):
  they can be deleted without losing anything.
- **Logs and sessions** (`tool-audit.jsonl`, Pi's session files, the Claude
  Code session and usage files): append-only, and Pi owns its format.
- **Archive manifests** (`archive.json`): they travel with the archived folder.
- **The desktop app's own files** (`connections.json`,
  `connection-credentials.json`, `remote-access.json`, `local-server-key.json`):
  they belong to the app, not to an environment, are read before any
  environment opens, and have one writer.

## Consequences

- A Wisp and its settings are created, changed and deleted together, and a
  backup of a running server is consistent for settings too.
- Settings get layout versions: a change of shape is an upgrade like any other,
  and the stores stop reading leniently.
- The data directory loses up to four files per Wisp, and six for the environment.
- Settings are no longer edited by hand in a text editor. Nothing documents
  doing so, and the app validates every change.
- Data written by this layout cannot be opened by v0.25.3. The floor
  ([ADR 036](036-upgrade-floor.md)) does not move: this layout opens v0.25.3's
  data and upgrades it.

## Deferred

- Splitting the JSON values into columns. A setting's shape changes more often
  than a Wisp's, and nothing queries inside it yet.
- Moving the desktop app's files into storage of its own.

## Decisions taken with the user

- Settings belong in the database, not in YAML or other files.
- No compatibility with older builds is kept beyond the upgrade from v0.25.3.

## Rejected alternatives

- **YAML files.** Easier to edit by hand, which nothing needs, and they keep
  every cost of JSON files: no transaction, no layout version, and backups out
  of step with the database.
- **One table with an owner kind.** Simpler, but a foreign key cannot point at
  either a Wisp or a conversation, so deleting one would need its own cleanup.
- **A separate settings database.** It would keep the transaction and backup
  problems between two files.
- **Moving credentials into the database.** It would put secrets in every copy
  of the database and in backups that are meant to be safe to move.
