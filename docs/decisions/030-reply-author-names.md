# ADR 030: Replies keep their author's name

- Status: Accepted
- Date: 2026-10-24
- Decision owners: Wisp maintainer, backend, renderer
- Scope: What an incoming message records about the Wisp that wrote it, and
  how a circle names replies whose Wisp has left it or been deleted
- Related: [ADR 010](010-wisp-entity.md), [ADR 011](011-circles.md)

## Context

An incoming message names its author only by ID (`authorId`). The name, color
and appearance live in the `wisps` row, and both the circle's transcript and
the history each member is told look the author up there, or among the
circle's current members.

Deleting a Wisp deletes its row, its own conversation, and its place in every
circle and session, through foreign keys. Its replies in circles stay: the
circle's conversation does not belong to the Wisp, and `messages.author_id`
has no foreign key. They are left with an ID that names nothing, so the
transcript shows them without a name, and other members read them as "A Wisp".

## Decision

**Every incoming message with an author also records the author's name when
it is written (`authorName`).** The Wisp's current name still wins while the
Wisp exists, so a rename reaches old replies; the recorded name is used only
when the ID names no Wisp.

- The backend sets it wherever it sets `authorId`, in a Wisp's own
  conversation as in a circle. A Wisp's own conversation is deleted with it,
  so the name is never needed there, but one rule is simpler than two.
- Only the name is kept. A deleted Wisp is drawn gray in the default shape,
  marked "deleted", so its replies stay readable without keeping its look.
- Store version 13 adds the name to replies already stored whose Wisp still
  exists. Replies of Wisps deleted before then cannot be named, and show as
  "Deleted Wisp". Older readers ignore the field, so `MIN_READER_VERSION` stays.
- In a circle, a reply is named by its current member, then by any Wisp that
  still exists (one that left the circle), then by the recorded name. The
  history told to members follows the same order before "A Wisp".

## Alternatives considered

- **Keep deleted Wisps as tombstones** (a `deleted_at` column): every query on
  Wisps would have to filter them, and the foreign keys that clean up after a
  deletion would no longer fire.
- **A table of deleted Wisps' names**, written on deletion: one row per Wisp
  instead of a name per reply, but new state to send to the renderer, and a
  deletion path that must never forget to write it.
- **Copy the whole appearance into each reply**: a deleted Wisp would keep its
  look, at seven fields per reply for a case the gray Wisp already covers.

## Consequences

- A reply is self-describing: wherever it is read, it carries who wrote it.
- A Wisp renamed and then deleted shows, on each reply, the name it wrote
  that reply under.
- Mentions of a deleted Wisp in earlier messages are plain text again, since
  there is no conversation left for them to open.
