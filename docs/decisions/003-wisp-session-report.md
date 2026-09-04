# ADR 003: Wisp session report boundary

- Status: Accepted
- Date: 2026-09-03
- Decision owners: Wisp product and security boundary
- Scope: SWE-99 — Wisp settings session activity (tool calls, token usage, session data)

## Decision

Each Wisp's settings screen exposes a read-only, on-demand session report built in the Electron main process from the Pi session file persisted under the user-data directory. The report is a derived, bounded, sanitized view — never raw Pi entries, tool payloads, provider-native objects, or file contents.

The report is pull-based over a dedicated validated IPC channel (`wisp:conversations:get-session-report`). It is not part of the sequenced agent event stream: the settings screen may be opened when the agent is idle or not yet created, the session file is persisted by Pi on every `message_end`, and a request-scoped report avoids complicating the streaming/reload contract from ADR 001.

## Report contents

The report covers, per Wisp session:

- Tool calls — name, summarized arguments, status (completed/error/pending), timestamp. Only workspace tool names already allowed by the translator (`read`, `grep`, `find`, `ls`, `edit`, `write`) are reported.
- Token usage — input, output, cache read, cache write, and total tokens, aggregated per model and for the whole session.
- Session data — session ID, models used (each persisted assistant message records its provider and model), and sanitized errors plus compaction events.

Retry notices are out of scope for this slice: retries are not persisted in the Pi session file and are already surfaced transiently as `conversation_notice` events. Compaction and sanitized errors are persisted and therefore reported.

## Sanitization

Tool arguments are summarized through a strict field whitelist (`path`, `pattern`, `include`, `glob`, `query`, `regex`). Values are capped and workspace paths are relativized. Everything else — notably `content`, `oldText`/`newString`, and any other argument data — is dropped. Tool outputs and tool result content never cross the bridge. Error details reuse the translator's sanitizer (bounded, no stacks, no provider bodies) and are identical to what the chat already displays. Argument summaries and report arrays are capped (last 50 tool calls, last 50 events) and the session file is bounded by a size check before parsing.

## Cost estimation

Token counts are the source of truth. Cost is an estimate computed from third-party model pricing: the public OpenRouter models endpoint (`GET https://openrouter.ai/api/v1/models`), which matches the app's supported provider set. The response is cached in the user-data directory with a TTL and refreshed best-effort; a report never blocks or fails on pricing fetch. When pricing is unavailable for a model, its cost is omitted rather than reported as zero. No credentials, prompts, or conversation data are sent to the pricing endpoint.

## Renderer

The settings panel renders the report in an expandable section, fetched lazily on first expand, with explicit loading, empty, and error states. The renderer never derives the report itself and never reads the session file.

## Rejected alternatives

- Extending the agent event stream with usage/tool-argument data: rejected because it pollutes the ordered streaming contract and still requires a durable source for historical data.
- Persisted per-turn `usage.cost` from the Pi catalog as the cost source: kept as a fallback option only; the catalog returned zero for several OpenRouter models in practice, so third-party pricing is authoritative.
- A live `AgentSession.getSessionStats()` read: rejected as the primary source because it requires a running session and misses idle or not-yet-created Wisps.
- Renderer-side parsing of the session file: rejected because it breaks the trust boundary (session files live in privileged user-data directories).

## Acceptance tests

1. A fixture session file yields correct token totals, per-model attribution, and tool call statuses.
2. Summarized arguments contain whitelisted fields only, with workspace paths relativized and long values truncated; file content from `edit`/`write` arguments never appears.
3. Compaction and sanitized errors are reported; retries are not.
4. Wisps without a Pi session file (fake agent mode, never-configured model) return an empty report rather than an error; circles are rejected.
5. Pricing is served from cache when the fetch fails, and cost is omitted when a model has no pricing.
6. The report crosses IPC only through the validated channel and typed bridge method.
