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
Wisp            id, name, role, soul, shape, color?, avatarImage?
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

## Migration

- The SQLite store gains a `wisps` table and raises its layout to version 4.
  Earlier builds cannot read the new records, so the oldest supported reader is
  also version 4; an earlier build sets the database aside rather than misread
  it.
- Records saved before this change (store layouts 1 to 3, the legacy JSON
  store, and the renderer's old local storage) are split when read: the Wisp
  keeps the conversation's ID, and the single old folder ID keeps naming all
  three folders, so no file moves. The records are written back in the new
  layout in one transaction.
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
