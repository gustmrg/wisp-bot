# ADR 029: Wisp memory

- Status: Accepted
- Date: 2026-10-23
- Decision owners: Wisp backend and security boundary
- Scope: Where memory is stored, how a Wisp writes it, how it reaches the
  prompt, how it is exported, and how the code is laid out
- Related: [ADR 008](008-wisp-skills.md), [ADR 010](010-wisp-entity.md),
  [ADR 027](027-runtime-neutral-storage-folders.md),
  [context and memory](../context-and-memory.md); Linear SWE-162, SWE-153,
  SWE-154, SWE-188, SWE-219, SWE-228

## Context

Memory today is two pieces of free text that only the user edits:

| What | Where | Limit |
|---|---|---|
| Saved memory (one per Wisp) | `memory` in `wisp-config/<Wisp storage ID>/context-settings.json` | 8,000 characters |
| User profile (one per person) | `aboutYou` and `responsePreferences` in `user-profile.json` | 2,000 each |

No tool writes either. Asked to "remember that…", a Wisp reaches for the only
persistent write it has, `save_skill`, and saves a skill (SWE-188). The
`## User-maintained memory` section is added only when the saved memory is not
empty (`backend/wisp-session-plan.ts`), so a Wisp with none does not know it
exists.

We looked at Hermes Agent, OpenClaw and ai-memory (research in SWE-162):

- **Hermes Agent** keeps `USER.md` and `MEMORY.md`, injects both whole, and
  gives the model a dedicated memory tool with add, replace and remove,
  bounded by a character limit per file.
- **OpenClaw** keeps memory as Markdown in the workspace, edited with the
  ordinary file tools, plus daily notes and a search index.
- **ai-memory** compares the wider field (Mem0, Zep/Graphiti, basic-memory);
  most add retrieval and LLM consolidation, which we leave for later.

The research pointed at Markdown files as the source of truth. Our
requirements are per entry: stable IDs for patch and remove; origin, date,
status and expiry in fields the model cannot write; one transaction when two
Wisps write the user scope at once; and a settings screen that lists entries.
A table meets them directly; a file would need a parser and a lock.

## Decision

**Memory is a list of one-line entries in a `memory_entries` table in the
app's SQLite database. A Wisp writes it only through a `save_memory` tool,
after the user approves. Markdown is how memory is shown, to the model and on
export, never where it is kept.**

### Scopes

- **`user`**: one per person, shared by every Wisp. It replaces `aboutYou` and
  `responsePreferences` in the profile. The preferred name stays in the
  profile: it is a setting, not a memory.
- **`wisp`**: one per Wisp. It replaces the saved memory.
- `USER.md` and `MEMORY.md` are the titles of the two rendered blocks and the
  names of the exported files.

### Storage

```sql
CREATE TABLE memory_entries (
  id          TEXT PRIMARY KEY,           -- short and stable: m1, m2, …
  scope       TEXT NOT NULL,              -- 'user' | 'wisp'
  wisp_id     TEXT,                       -- NULL exactly when scope = 'user'
  text        TEXT NOT NULL,              -- one line
  source      TEXT NOT NULL,              -- 'owner' | 'agent'
  status      TEXT NOT NULL,              -- 'active' | 'superseded' | 'removed'
  replaces    TEXT,                       -- the entry a patch superseded
  observed_at TEXT NOT NULL,
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((scope = 'user') = (wisp_id IS NULL))
) STRICT;
```

- **Same database file, own tables.** The table lives in
  `conversations.sqlite`, so the backup before an upgrade
  (`backend/sqlite-backup.ts`) and the server backup (`server/backup.ts`)
  already cover it, and each environment keeps its own memory. The memory
  module creates and upgrades its tables itself, with its version in a
  `memory_meta` table, not in the conversation store's `meta`. Before an
  upgrade it calls back to the app, which backs the database up as it does for
  its own upgrades.
- **No foreign key to `wisps`.** `wisp_id` holds the Wisp's `id`, not its
  storage ID: the storage ID names folders, the ID names the Wisp. Leaving out
  the foreign key keeps the module independent of the conversation schema; the
  repository removes a Wisp's entries when it deletes the Wisp (see
  [Export](#export)).
- **Nothing is deleted by the model.** `remove` sets `removed` and `patch`
  sets `superseded` on the old entry, so the user can restore both. Removed
  entries are also evidence that SWE-154 must not propose them again.
- `topic` and `pinned` are left to SWE-219.

### The `save_memory` tool

```ts
type MemoryOperation =
  | { op: "add"; scope: "user" | "wisp"; text: string; expiresAt?: string }
  | { op: "patch"; id: string; text: string }
  | { op: "remove"; id: string };

save_memory({ operations: MemoryOperation[] })
```

- **Scopes from the start**, so the contract does not change when SWE-154
  arrives.
- **One transaction per call.** Every operation applies, or none does. There is
  no `replace` of a whole scope.
- **Entries are referenced by the short ID** shown in the injected block
  (`[m12]`), not by matching a piece of text.
- **One line per entry**, a declarative fact ("Prefers answers in pt-BR"), not
  an instruction ("Always answer in pt-BR"). Replacing a preference is a
  `patch`, which supersedes the old entry.
- **Limits per scope:** 1,500 characters for `user` and 4,000 for `wisp`,
  counted over active entries. Going over fails the whole call with the current
  entries and how many characters must go.
- Exact duplicates of an active entry in the same scope are rejected.
- Writes from the tool get `source = agent`; entries created or edited in
  settings get `source = owner`.
- **Approval:** a card shows the diff, as for `save_skill` (ADR 008).
- Not offered in job runs (`TOOLS_NEVER_IN_JOB_RUNS`).
- **What is never saved:** secrets, credentials, and content that came from
  tools, pages or integrations. The prompt says so, and a write from a Wisp
  (`source = agent`) is rejected when its text looks like a credential. What
  the person types in settings is theirs to keep.
- The module has a fourth operation, `restore`, which settings use and the
  tool does not offer.

### Skill or memory

The prompt and the tool descriptions say it: a skill is a reusable procedure;
a memory is a fact, preference or piece of context. An explicit request to
remember or save something to memory **always** goes to `save_memory`, never
to `save_skill`. Hermes's rule (true in every session → memory; tied to a kind
of task → skill) applies only to what a Wisp proposes on its own (SWE-154).

### In the prompt

- The `## Memory` section is **always** present, empty or not, and says what
  memory is for and how to save to it, unless the Wisp's memory is off (see
  [Settings](#settings)).
- It renders every active, unexpired entry of both scopes in Markdown, `USER.md`
  first, then `MEMORY.md`, oldest first, each line as `- [m12] text`. Each
  title carries the scope's use (`USER.md · 42% of 1,500 characters`).
- The order and wording are fixed so the block is byte-identical while memory
  does not change, keeping the prompt cache warm.
- It stays in the run sections, read again on every run as the saved memory is
  today, so an approved save applies from the next message.
- There is no memory search in this phase. SWE-219 adds a core that is always
  injected, an archive behind `search_memory`, and an index line in the prompt.
  `search_memory` stays separate from `search_history`: memory is curated
  facts, history is what was said. Nothing is retrieved automatically before a
  turn.

### Export

`USER.md` and `MEMORY.md` are not files the app keeps. They are produced from
the table when needed, with the same rendering as the prompt, without the IDs:

- **On request:** **About you** in **Settings → General** has an export
  button that downloads `USER.md`, and a Wisp's **Memory** settings one that
  downloads that Wisp's `MEMORY.md`. Each Wisp's file
  has only its own entries; `USER.md` is the same for every Wisp.
- **When a Wisp is deleted:** its `MEMORY.md` is written into its entry in the
  archive, beside the folders ADR 010 already archives, and then its rows are
  removed in one transaction. `USER.md` is not touched.

No copy is kept in `wisp-config/<Wisp storage ID>/`. A copy beside the Wisp's
files would look editable, and an edit there would be lost or would have to be
read back, which is the two sources of truth the table exists to avoid.

### Settings

- The `user` scope is the person's, not a Wisp's, so it is edited in
  **Settings → General**, under the name, as **About you**. A Wisp's
  **Memory** settings list only its own entries ("This Wisp") and link to
  it. Both show the scope's use of its limit. Settings ask for the person's
  memory with no conversation, which reaches only the `user` scope, so it can
  be read and changed before any Wisp exists. (Settings first showed both
  scopes in every Wisp's **Memory**, which made the shared list look like
  each Wisp's own.)
- Each entry shows its origin (You or Wisp), date and expiry, and can be edited
  in place, removed, or restored when superseded or removed. Entries can be
  added by hand.
- **Edit as text** shows the active entries one per line. Saving compares line
  by line: an unchanged line keeps its ID and metadata; an edited line removes
  the old entry and adds a new one with `source = owner` and today's date; a
  missing line is removed. A summary ("2 added, 1 removed") is shown before
  confirming, and everything applies in one transaction.
- **Use memory** turns a Wisp's memory off (SWE-228). The Wisp's `memoryOff`
  flag is stored on the Wisp, not on the entries, so nothing is deleted. While
  it is set, the agent context has no memory access, the prompt has no
  `## Memory` section (a short `## Memory off` note says why instead, so the
  Wisp does not promise to remember or save a fact as a skill), and
  `save_memory` is not among the allowed tools. Both are read on every run and
  refresh, so the change applies from the next message. One switch covers both
  scopes; switching off only `MEMORY.md` is left for later.

### Migration

The first start with the memory module splits the saved memory of every Wisp
and the profile's `aboutYou` and `responsePreferences` by line or bullet. Each
piece becomes an active entry with `source = owner` in the matching scope.

- The entries and a `migrated` marker in `memory_meta` are written in one
  transaction, so a start interrupted halfway imports everything again, and a
  later start imports nothing.
- The old fields are left as they are and no longer read or shown. An older
  build still finds them, so going back loses only what changed after the
  migration.
- A scope that ends up over its limit keeps every piece: the limit applies to
  new writes, never by dropping what the user wrote. The settings screen shows
  the scope as over its limit.

### Code layout

Memory is a module of its own, in `backend/memory/`, so it can become a
separate project (an MCP server, for instance) if something besides Wisp needs
it.

- **In the module:** the table and its upgrades, the operations with their
  limits and duplicate check, the rendering to Markdown, and the migration of
  the old text into entries. `backend/memory/index.ts` is its only entry point
  and exports the public types (`MemoryEntry`, `MemoryOperation`,
  `MemoryScope`).
- **In Wisp:** the `save_memory` tool and its approval card, the `## Memory`
  section in `wisp-session-plan.ts`, the settings screen, reading the old
  files for migration, and removing a deleted Wisp's entries.
- **Rules that keep it extractable:**
  - Nothing in `backend/memory/` imports from outside it; Wisp depends on the
    module, never the other way round.
  - The module receives its SQLite connection; it does not open the app's
    database itself. Its writes are transactions of their own, or savepoints
    when the caller already opened one.
  - `wisp_id` is an opaque string to it.
  - Its interface takes and returns plain, serializable data, so a direct call
    can become a remote one without changing callers.
  - Its tests run on their own, with an in-memory database, without starting
    Wisp.

## Consequences

- A Wisp can save what it is asked to remember, and SWE-188 is fixed by the
  same change (SWE-153).
- Every Wisp sees the `user` scope, so one Wisp's write reaches the others.
  The approval card is where the user stops what should not be shared.
- Memory is read from the table only. The old fields in
  `context-settings.json` and `user-profile.json` stay behind, frozen at the
  migration, until a later change removes them.
- Memory now costs prompt space in every Wisp, bounded by the two limits.

## Deferred

- Memories a Wisp proposes on its own, from a background pass with required
  evidence and a queue the user approves (SWE-154).
- Memory search, a core and an archive, and `search_memory` (SWE-219).
- Daily notes, LLM consolidation ("dreaming"), vector search, decay, external
  memory providers and capture through hooks.

## Rejected alternatives

- **Markdown files as the source of truth:** no stable IDs or protected
  metadata per entry, and two Wisps writing `USER.md` at once need a lock.
  Simpler only if settings were a single text area.
- **Editing memory with the workspace file tools (OpenClaw):** memory would
  live in the conversation's workspace, where commands and other tools can
  rewrite it, and a write would have no approval of its own.
- **A copy of `MEMORY.md` in the Wisp's config folder:** two sources of truth
  (see [Export](#export)).
- **A separate memory service from the start:** the approval card, the prompt
  section, the settings screen and the migration all stay in Wisp, so a
  service would move only the table, and add a process to run, authenticate,
  back up and keep alive in both the desktop app and the server. The module
  boundary keeps that option open.
- **A foreign key from `memory_entries` to `wisps`:** ties the module to the
  conversation schema it is meant to be independent of.
