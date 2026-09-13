# Context and memory

Open **Wisp settings → General → Context & memory** to configure context
renewal for a Wisp. By default, the next message after 24 hours of inactivity
triggers a continuity summary only when the active context is at least 12,000
tokens. Both values are configurable (inactivity between 1 and 720 hours;
minimum context between 1,000 and 200,000 tokens). Optional daily renewal uses
the computer's local time, is evaluated on the next message, and also requires
the minimum context size. Nothing runs just because the clock passes the
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
saved memory. A timeline marker explains each boundary.

## Saved memory

**Saved memory** is user-maintained text, stored locally and included in model
requests. It survives new topics and restarts; facts are not silently promoted
from summaries into permanent memory.

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
