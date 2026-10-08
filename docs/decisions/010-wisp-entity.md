# ADR 010: Wisps stored apart from conversations

- Status: Accepted
- Date: 2026-10-07
- Decision owners: Wisp product and data model
- Scope: What a Wisp is, how it is stored, and which files belong to it
- Related: [Architecture](../architecture.md), [ADR 006](006-paged-conversation-transcripts.md),
  [ADR 008](008-wisp-skills.md)

## Context

A Wisp used to be a conversation: one record held its identity (name, label,
description, appearance, tone), its transcript, and its agent session, and one
ID named its workspace, session, and settings folders. A Wisp could not exist
apart from its conversation, so it could not take part in a circle without
being one, and circles referenced conversations rather than Wisps.

Its behavior was also split between two places. The description was injected
into the system prompt as the Wisp's authoritative identity, and a separate
tone (a style and a response length) added instructions that could contradict
it.

## Decision

### The Wisp is its own entity

```text
Wisp            id, name, role, soul, appearance, color?
Conversation    a Wisp's own conversation (kind "wisp", wispId) or a circle
                (kind "circle", name, label, description, memberIds)
Message         as before; incoming messages carry the authorId of the Wisp
                that wrote them
```

- Every Wisp has exactly one conversation of its own, created and deleted with
  it, and that conversation shares the Wisp's ID. Integration grants, message
  queues, scheduled messages, and usage stay keyed by that ID, so they keep
  working unchanged.
- Circles list Wisps (`memberIds` are Wisp IDs). Deleting a Wisp removes it
  from every circle.
- A Wisp's own conversation can no longer be created, changed into a Wisp, or
  deleted through the conversation operations. The `createWisp`, `updateWisp`,
  and `deleteWisp` operations own the Wisp; `updateConversation` changes only
  what belongs to a conversation (notifications, read state, and a circle's
  name, label, description, and members).
- Conversation state carries `wisps` beside `chats`. The renderer joins them
  into views (`chat.wisp` for a Wisp's conversation, `chat.members` for a
  circle).

### The soul defines the Wisp

The description became the **soul**: a Markdown document that defines the
Wisp's identity, personality, and behavior. The settings show it as a Markdown
editor with a preview and starting templates. The short **role** (formerly the
label) stays as the line shown under the name and in the system prompt.

The tone and response length were removed. The prompt's response style now
follows, in order: the person's current message, the Wisp's soul, the response
preferences in the person's profile, then neutral defaults. When a soul says
nothing about tone, the model follows the profile and defaults.

### Folders follow their owner

| Belongs to | Folder | Holds |
|---|---|---|
| The Wisp | `pi-config/<Wisp storage ID>` | Skills, saved memory, context settings, Pi settings |
| The conversation | `workspaces/<conversation storage ID>` | Files the Wisps in it work on |
| A Wisp in a conversation | `pi-sessions/<session ID>` | That Wisp's agent history there |

What the person curates (the soul, skills, saved memory) goes with the Wisp
into every conversation. What is produced while working stays in the
conversation, so the Wisps in a circle will share one workspace. A Wisp in a
circle brings its own memory; since every Wisp belongs to the same person, who
chose to add it, that is intended.

Storage IDs are not Wisp or conversation IDs, so a deleted Wisp's archived
folders never collide with a new one that reuses an ID.

Context settings (renewal policy) still live with the Wisp. They belong with
each Wisp's session in a conversation once circles run agents.

### Storage layout

Records are stored as columns, and the relations between them as foreign keys.
Until now each table held a whole record as JSON beside its ID, a pattern
carried over from the JSON file store. The database could then not check what
relates Wisps and conversations: a circle's members, a Wisp's own
conversation, and the sessions in a conversation all lived inside a JSON
value, and only TypeScript kept them consistent.

| Table | Holds | Relations |
|---|---|---|
| `wisps` | Name, role, soul, appearance (one column per axis), color, storage ID, model override | — |
| `conversations` | Kind, a circle's name, label, and description, notification and read state, preview, last activity, storage ID | `wisp_id` names the Wisp a Wisp's conversation belongs to (it shares the Wisp's ID) and is deleted with it |
| `circle_members` | A circle's members in order (`position`) | Conversation and Wisp; a deleted Wisp leaves every circle |
| `participant_sessions` | Each Wisp's agent session in a conversation | Conversation and Wisp |
| `messages` | The message `body` as JSON, with `type`, `created_at`, and `author_id` derived from it as generated columns | Conversation |
| `scheduled_messages` | Text, time zone, next send, send count, dates; the `schedule` as JSON | Conversation |
| `queued_messages` | Text, date, and where a scheduled message came from | Conversation |

The rule is to give a field its own column unless its shape varies:

- **Message bodies stay JSON.** A message is a union of types (text, time,
  card, prompt) with nested lists (card items, prompt options, reactions).
  Columns for them would mean several tables or many empty columns, and the
  search index already reads the body through `json_extract`. The fields a
  query may need are generated columns, so they can never disagree with the
  body.
- **A schedule stays JSON.** New kinds of schedule (recurring ones) join the
  `MessageSchedule` union without changing the table.

- **A Wisp's appearance columns have no `CHECK`.** Their values are display
  choices that grow often, and SQLite cannot change a `CHECK` without
  rebuilding the table, which now has foreign keys pointing at it. The
  repository validates them on read, and an unknown value falls back to the
  default, so an older build still shows a Wisp a newer one changed.

The gain is integrity and a readable schema, not speed: the main process still
reads every Wisp and conversation at startup and queries them in memory.

### How a Wisp looks

A Wisp is drawn from its **appearance**: a body (`round`,
`drop`, `pebble`, `crystal`, `block`) and a **trail** (`hook`, `flame`,
`curl`, or `none`), plus the tone, eyes, eye color, finish, and mark. The
trail is the family trait: at 24 px bodies blur together, but trails stay
apart, and the app icon has one. The color is one of the ten palette colors;
a tone of `soft` is the same color, lighter. The backend stores and checks the
IDs (`shared/wisp-appearance.ts`); the renderer owns the geometry.

Small sizes keep only what survives them: below 32 px the mark goes and the
eyes grow, and below 28 px an outline fills in. In the sidebar the Wisp shows
what its conversation is doing: the trail sways while it works, the eyes grow
while it waits for approval, and it fades with its trail down after a reply
failed. Approval and failure also put a dot in the avatar's bottom corner
(amber and red); the failure dot clears when the conversation is opened.
`docs/design/wisp-trail-study.html` is the study these choices came from.

## Migration

- The SQLite store moved to layout 4 (a `wisps` table of JSON records) and
  then to layout 5 (records as columns). Earlier builds cannot read either, so
  the oldest supported reader is also version 5; an earlier build sets the
  database aside rather than misread it.
- A store with JSON records (layouts 1 to 4) is read as it is. Records saved
  before this change (store layouts 1 to 3, the legacy JSON store, and the
  renderer's old local storage) are split when read: the Wisp keeps the
  conversation's ID, and the single old folder ID keeps naming all three
  folders, so no file moves. Then, in one transaction with foreign keys off,
  the record tables are replaced by the new ones, every record is written
  back, messages gain their generated columns, messages left without a
  conversation are removed, and the foreign keys are checked before commit.
- A Wisp saved with a shape gets the closest body (`circle` → round,
  `square` → block, `triangle`, `diamond`, and `hexagon` → crystal, `drop` →
  drop, `pebble`, `pill`, and `cloud` → pebble), no trail, and the flat look it
  had. A color outside the palette moves to the closest palette color. Stores
  written by earlier layout 5 builds, with a `shape` column, get the appearance
  columns in place when opened.
- A stored tone is appended to the soul as `## Tone` and `## Response length`
  sections with the instructions it used to add, so the Wisp keeps sounding the
  same.
- The `isActive`, `timestamp`, and `systemRole` fields are dropped: nothing
  read `isActive`, `lastActivityAt` replaces `timestamp`, and the only
  `systemRole` belonged to a removed demo conversation.
- The remote protocol version is 2. A desktop app and a remote server must be
  updated together.

## Not yet

Circles still have no agents. Running them needs a session per member (the
`sessions` map on a conversation record already allows it), deciding which
Wisp answers, and showing each message's author.
