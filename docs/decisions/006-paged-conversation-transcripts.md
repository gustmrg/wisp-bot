# ADR 006: Paged conversation transcripts and indexed message search

- Status: Accepted
- Date: 2026-09-30
- Decision owners: Wisp product and storage boundary
- Scope: How conversation transcripts are loaded, sent to the renderer, and searched
- Related: [ADR 001](001-agent-runtime.md) (IPC boundary), [architecture](../architecture.md#data-storage)

## Context

Conversations are stored in SQLite (`conversations.sqlite`), with one row per
conversation and one per message, so each change writes only its own rows. But
three things still grow with total history:

- **Startup and memory.** The main process reads every message into memory at
  launch (about 55 ms and the full transcript size for a 19 MB store) and keeps
  it there, although only the conversation being viewed needs its messages.
- **Renderer traffic and rendering.** The conversation state sent to the
  renderer carries every transcript, and the chat panel renders the whole
  transcript of the open conversation with no windowing.
- **Search.** The search dialog scans every transcript held in the renderer on
  each keystroke. This is the only feature that needs every message, and it is
  why the renderer holds them all.

Only these places read full transcripts today:

| Place | Need |
|---|---|
| `ConversationStore.read` at startup | Loads all messages into memory |
| `ConversationService` and `ConversationRepository` | Find one message by ID (delivery status, prompt answers, ownership check) |
| `search-dialog.tsx` via `findMessageSearchMatch` | Substring search across all messages |
| `chat-panel.tsx` | Render the open transcript; auto-scroll when the message count changes |
| `chatActivityDate` in `date-dividers.ts` | Sidebar time from the latest message |
| `use-conversations.ts` retry | Find the original outgoing message by ID |

The streaming overlay in `conversation-stream.ts` keys every transient message
by ID, so it does not need the rest of the transcript.

To keep memory bounded, each conversation currently keeps only its newest
10,000 displayed messages and drops older ones.

## Decision

Split the conversation list from the transcripts:

1. The main process keeps **conversation summaries** in memory (name, preview,
   last activity, and other metadata) and reads **messages from SQLite on
   demand**, one page at a time.
2. The renderer receives summaries for every conversation, and **message
   windows** only for conversations the user opens, loading older pages as the
   user scrolls up.
3. **Message search runs in the main process** against a full-text index and
   returns matches; opening a match **scrolls to that message**.
4. The **per-conversation message cap is removed**: stored history is
   unbounded.

Product decisions recorded here:

- Message search requires **at least 3 characters**. Shorter queries search only
  Wisp and circle names, labels, and descriptions, as today.
- Selecting a search result **opens the conversation scrolled to the matching
  message** and briefly highlights it.
- Stored history has **no message cap**. Bounds remain on individual request
  payloads (for example, the one-time legacy import).

## Main process

### Memory and startup

`ConversationRecord` keeps its metadata but no longer holds `chat.messages`.
Startup reads only the `conversations` table (under 1 ms for 20 conversations,
independent of history). The conversation row also stores `lastActivityAt`
(the latest message time), which replaces scanning messages for the sidebar.

Message operations go to SQLite directly:

- **Upsert** by `(conversation_id, id)`, as today; the row keeps its position.
- **Lookup by ID** through the existing `UNIQUE (conversation_id, id)` index,
  replacing the in-memory `messages.find` calls.
- **Pages** by position (`seq`) through the existing
  `messages_by_conversation (conversation_id, seq)` index. Measured on a 19 MB
  store: newest 50 messages 0.13 ms, 50 older than a cursor 0.12 ms, 50 around a
  given message 0.19 ms.

Live streaming messages stay in `ConversationService` and are overlaid on the
newest page and on change deltas, as they are overlaid on full chats today.

### Store versioning

The search index needs a store layout change. Store version 1 has not shipped
in a release (0.2.0 uses the JSON store), so before the first release that
contains SQLite, the exact version check in `ConversationStore.read` becomes a
compatibility check:

- `store_version` records the layout that last wrote the database.
- `min_reader_version` records the oldest layout that can still read and write
  it safely.

This layout change is additive: the index is maintained by triggers (below),
so an older build that writes messages keeps it current. Version 2 therefore
sets `min_reader_version = 1`, and a downgrade keeps working instead of setting
the database aside.

### Message search

A contentless FTS5 table indexes each message's searchable text, keyed by the
message row's `seq`:

```sql
CREATE VIRTUAL TABLE message_search USING fts5(
  text, content = '', contentless_delete = 1,
  tokenize = 'trigram remove_diacritics 1'
);
```

- **Trigram tokenizer.** It keeps today's substring matching ("kube" finds
  "Kubernetes"). It matches case- and accent-insensitively ("orcamento" finds
  "orçamento"), and it cannot match queries shorter than 3 characters, which
  fits the minimum above. Verified in Electron 43's bundled SQLite (3.53.1).
- **Triggers keep it in sync.** `AFTER INSERT`, `AFTER UPDATE`, and
  `AFTER DELETE` triggers on `messages` derive the searchable text from the
  message JSON in SQL (`json_extract` and `json_each`). Every write path,
  including cascades from conversation deletion, therefore keeps the index
  consistent. The text matches today's `messageSearchFragments`: text messages'
  text, card labels and text, and prompt questions, options, and answers. Time
  dividers are excluded.
- **One source of truth for searchable text.** `messageSearchFragments` moves
  to `shared/` and builds result snippets from the message body. A test runs the
  SQL derivation and the TypeScript fragments over every message type and
  checks that they agree.
- **Query shape.** The query takes the newest matches straight from the index
  (`WHERE message_search MATCH ? ORDER BY rowid DESC LIMIT 50`), then loads
  those rows by `seq`. Measured on 20,000 messages: 0.2–0.8 ms, including a
  substring common to most messages. Joining first and sorting every match took
  296 ms for that same query, so the query must keep this shape.
- **Isolation.** History is now unbounded and `node:sqlite` is synchronous, so
  search runs on a worker thread with its own read-only connection (WAL allows
  concurrent readers). A broad query can then never stall the main process or
  streaming replies. Verified in Electron 43: the main thread stayed responsive
  during worker queries.
- **Input safety.** The query is trimmed, limited to 200 characters, required
  to be at least 3 characters, and always passed to FTS5 as a quoted phrase, so
  user input is never parsed as FTS syntax.
- **Backfill.** The version 2 migration builds the index from existing rows in
  one transaction (about 1 s for 20,000 messages).

Results reflect stored messages; a reply that is still streaming becomes
searchable when it completes.

## IPC contract

| Channel | Today | After |
|---|---|---|
| `getConversationState` and structural changes (create, update, delete, initialize) | Full chats with every message | `ChatSummary` per conversation, no messages, plus the messages not stored yet |
| `appendConversationMessage`, `answerConversationPrompt`, `markConversationRead` | One full `Chat` | `ConversationDelta`: the summary plus the changed messages |
| `conversationChanged` push | One full `Chat` | `ConversationDelta` |
| `getConversationMessages` (new) | — | One `MessagePage` |
| `searchMessages` (new) | — | Up to 50 `MessageSearchHit`s, newest first |

```ts
type MessagePageRequest =
  | { conversationId: string; page: "latest" }
  | { conversationId: string; page: "older" | "newer"; cursor: string }
  | { conversationId: string; page: "around"; messageId: string };

interface MessagePage {
  messages: ReadonlyArray<Message>; // oldest first
  olderCursor: string | null; // null: this page starts at the first message
  newerCursor: string | null; // null: this page reaches the newest message
}

interface MessageSearchHit {
  conversationId: string;
  messageId: string;
  snippet: string;
  createdAt?: string;
}

interface ConversationDelta {
  chat: ChatSummary;
  added: ReadonlyArray<Message>; // new messages at the end, oldest first
  updated: ReadonlyArray<Message>; // earlier messages whose content changed
}
```

A delta separates new messages from updated ones because a window holds only
part of a transcript. A new message joins an attached window. An update to a
message the window does not hold is ignored; without the distinction it would
be added at the end, out of place.

The conversation state also carries `liveMessages`: the messages the backend
has not stored yet (replies still streaming or being saved), as of the state's
`agentEventSequence`. A renderer that starts while a reply is streaming (a
reload, or a window reopened on macOS) continues the reply from them, since no
page would give it a base that is consistent with the event sequence.

Cursors are opaque strings (the row position) and are validated as such at the
IPC boundary. Pages hold 50 messages; an `around` page holds the target plus up
to 25 messages on each side.

## Renderer

- **State.** `use-conversations` keeps summaries for every conversation and a
  message window per opened conversation:
  `{ messages, olderCursor, newerCursor, loading }`. A window whose
  `newerCursor` is null is **attached** to the live end of the conversation.
- **Opening a conversation** loads its latest page. Windows are kept for the
  open conversation and the four most recently opened ones; older windows are
  evicted, and deltas for conversations without a window update only the
  summary.
- **Scrolling up** loads older pages when the top of the transcript comes into
  view. The first visible message keeps its position when a page is prepended.
  Auto-scroll to the bottom fires only when a new message arrives at the end,
  not when the message count changes; today's count-based trigger would jump to
  the bottom on every older page.
- **Deltas** update the messages a window holds and add new messages to an
  attached window. A delta that arrives while a page is being read is applied
  again when the page lands, because the page may have been read before the
  change. The streaming overlay is unchanged: it is keyed by message ID and
  renders on the attached window.
- **Search.** The dialog still matches conversation names, labels, and
  descriptions locally. For queries of 3 or more characters it also calls
  `searchMessages`, debounced, and lists message results newest first, each
  labeled with its conversation. Shorter queries show a hint that message
  search needs 3 characters.
- **Jumping to a result** loads an `around` page for the message, scrolls it
  into view, and highlights it briefly. That window is **detached**: new
  messages are not appended to it. A "Jump to latest" control reloads the
  latest page, and scrolling to the bottom of a detached window loads newer
  pages until it reattaches. Sending a message, or selecting the conversation
  in the list, also returns a detached window to the latest page.
- **Retry** finds the failed outgoing message in the window, where it always is
  because it was just sent. Otherwise it asks the backend for the message by
  ID.

## Rollout

Each step ships on its own and keeps every quality gate green.

1. **Backend additions, no UI change.**
   - Store version 2: the search index with triggers and backfill, and the
     `min_reader_version` check.
   - `getConversationMessages`, `searchMessages` (on the worker), and
     `lastActivityAt`.
   - Message lookups through SQLite.

   The full-state view still carries transcripts, so the renderer is unchanged.
2. **Renderer switch.** Summaries, message windows with older pages and scroll
   anchoring, deltas, backend search, jump to result with detached windows, and
   the sidebar time from `lastActivityAt`. The single-conversation channels and
   the push carry deltas, and the state gains `liveMessages`; the full-state
   view still carries transcripts, which the renderer no longer reads.
3. **Remove full transcripts.** Messages leave `ConversationStateView`, pushes,
   and startup, and the message cap is removed. Startup then reads only the
   conversation list.

## Consequences

- Startup time and main-process memory no longer grow with message history.
  Opening a conversation costs one page read (about 0.1 ms) and one IPC round
  trip.
- The renderer holds at most five windows of messages, so memory and DOM size
  stay bounded unless the user scrolls far back in one conversation. Windowed
  rendering can be added later if that case matters.
- Search finds any stored message across unbounded history without loading it.
- **Disk.** The trigram index is about twice the size of the text it indexes:
  it added 39 MB to a 19.9 MB store, measured on synthetic prose. A word-based
  index would add about 36% instead (see alternatives).
- Search results change shape: one row per matching message, newest first,
  instead of one row per conversation.
- One- and two-character queries no longer match message text.
- The renderer gains window state (attached and detached windows, cursors,
  eviction), which is the main complexity of this change.

## Alternatives considered

- **Keep transcripts in memory and only window the rendering.** This fixes DOM
  size but not startup time, main-process memory, or the full transcripts sent
  over IPC.
- **Word-based index (`unicode61`).** About 36% extra disk instead of about
  200%, but it matches words and word prefixes only, so a search inside a word
  ("bern" in "Kubernetes") would stop working.
- **`LIKE` scans without an index.** No disk cost, but every search reads every
  message, which grows without bound once the cap is removed.
- **Search in the renderer over loaded windows.** It cannot find messages that
  were never loaded, which after this change is most of them.
- **Keep the message cap.** It is no longer needed for memory, and it silently
  hides history the user may want to search or scroll back to.

## Verification plan

- **Store.**
  - Page boundaries and cursors, including after deletions.
  - `around` pages at both ends of a conversation.
  - Index consistency across insert, update, delete, and conversation-deletion
    cascade.
  - SQL and TypeScript searchable-text parity for every message type.
  - Quoting of query input, case and accent insensitivity, and rejection of
    queries under 3 characters.
  - Upgrade from store version 1, and a version 1 reader against a version 2
    store.
- **Renderer hooks.**
  - The latest page on open, older pages, and eviction.
  - Deltas for windowed and unwindowed conversations.
  - Jumping to a result, then back to latest.
- **Chat panel.**
  - Prepending keeps the scroll position.
  - A new message scrolls to the bottom only in an attached window.
  - A jump highlights the target.
- **Composition and runtime.**
  - The backend composition test covers pages and search through the real IPC
    handlers.
  - The runtime smoke test runs the compiled backend under Electron
    (`ELECTRON_RUN_AS_NODE`) against a migrated store.
- **Benchmarks.** Startup, append, page, and search timings on the 19 MB
  reference store, repeated after each step.
