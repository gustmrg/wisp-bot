# Token usage and session reports

## Per-Wisp session report

Open a Wisp's settings and select **Usage** to inspect its current Pi session,
model/token totals, tool status, compactions, and retries. Runtime version and
retry notices are recorded for sessions used by this version of Wisp; older
sessions may not contain them. Tool argument values, file contents, prompts,
and raw provider error details are excluded from reports.

## Token usage dashboard

Open **Settings → Token usage** for totals and a breakdown by Wisp over the
last 7 days, 30 days, or all saved history. Refresh reloads the persisted Pi
sessions, including earlier session files and compacted turns, without adding
duplicate usage. History is local and survives app restarts; the dashboard
covers existing Wisps. Deleting a Wisp removes it from this view.

Unreadable or oversized session files produce an explicit partial-history
warning.

## Cost estimates

USD values are estimates using the latest cached OpenRouter model pricing, not
historical invoices. The pricing cache is schema-versioned, refreshed daily,
and its update time is shown. Input, output, cache reads, and cache writes are
counted separately. Missing model/cache-write pricing yields an unknown cost,
rather than zero. Prices follow the
[OpenRouter model pricing fields](https://openrouter.ai/docs/guides/overview/models);
routing, conditional prices and non-token fees can differ from the estimate.

Summarization tokens from [context renewal](context-and-memory.md) appear as
their own subtotal.
