# Context and memory

Open **Wisp settings → General → Context** to configure context
renewal for a Wisp. By default, the next message after 24 hours of inactivity
starts a new topic, but only when the active context is at least 12,000
tokens. **On renewal** can instead summarize the context and continue, which
costs a summarization request and keeps the summary in every later request;
starting a new topic sends only the system prompt, memory and the new
message, and the Wisp can still reach earlier messages with `search_history`.
The thresholds are configurable (inactivity between 1 and 720 hours; minimum
context between 1,000 and 200,000 tokens). Optional daily renewal uses
the timezone from **Settings → General**, is evaluated on the next message,
and also requires the minimum context size. Nothing runs just because the clock passes the
configured hour. Native Pi compression near the model's context limit remains
enabled even with manual renewal selected.

Context controls require a configured Pi session and cannot interrupt a
response, queued message, or tool approval.

## Summarize context and new topics

**Summarize context** retains decisions, goals, pending work, references and
about 4,000 tokens of recent conversation using Pi's compaction boundaries. The
exact retained size depends on message boundaries. The summary is available in
settings. Summarization failure preserves the existing context and reports an
error rather than dropping history or sending the new message without
continuity.

**Start new topic** explicitly clears the active conversation context while
keeping all messages on screen, the local transcript, Wisp identity, model and
memory. A timeline marker explains each boundary.

## Memory

**Memory** is a list of one-line entries, stored locally and included in every
model request. It survives new topics and restarts; facts are not silently
promoted from summaries into permanent memory. Open **Wisp settings → Memory**
to see it in two groups:

- **About you · every Wisp** (`USER.md`): facts and preferences about you,
  shared by all of your Wisps, up to 1,500 characters.
- **This Wisp** (`MEMORY.md`): what only this Wisp remembers, up to 4,000
  characters.

Ask a Wisp to remember something ("remember that I prefer short answers") and
it calls `save_memory`; an approval card shows the exact change, and nothing is
written until you allow it. A Wisp saves only what you ask it to keep, never
credentials, and never on its own. Each entry shows who wrote it (you or a
Wisp) and when, and can be edited, removed, or restored later. **Edit as text** edits a group one line per entry and shows
what will change before saving; lines left as they are keep their history.
Each group can be exported as Markdown. Deleting a Wisp keeps its `MEMORY.md`
in the archive. The saved memory and the profile's "About you" and "Response
preferences" from earlier versions became entries on the first start. See
[ADR 029](decisions/029-wisp-memory.md).

## Skills

Ask a Wisp to save a workflow as a skill and it drafts reusable instructions
for you to approve; the approval card shows exactly what will be saved. Each
Wisp sees the names and descriptions of its own skills and loads one when a
request matches. Attach a SKILL.md and ask the Wisp to save it, and it saves
the file as written after your approval. **Wisp settings → General → Skills**
lists, imports, deletes, and opens the folder holding them. See
[ADR 008](decisions/008-wisp-skills.md).

## History search

The `search_history` tool can retrieve bounded excerpts from this Wisp's
earlier user/assistant messages when needed, including before compaction or a
new topic. It is a model-invoked tool, separate from the application-wide
search dialog (`Cmd/Ctrl+K`), which searches chats and messages directly.

## Usage

Usage totals include summarization input/output and cache tokens. Summary costs
use the runtime's persisted estimate when positive and available; unavailable
estimates remain unknown. The Usage tab identifies the summarization token
subtotal. See [token usage](token-usage.md).
