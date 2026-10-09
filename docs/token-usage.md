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
counted separately. Models that OpenRouter does not price (for example direct
providers such as Z.AI) fall back to the cost Pi recorded with each turn from
its own model catalog. A cost stays unknown, rather than zero, when neither
source has a price. Providers with automatic prompt caching (Z.AI, OpenAI and
others) report only cache reads, so cache writes show as 0 for them. Prices follow the
[OpenRouter model pricing fields](https://openrouter.ai/docs/guides/overview/models);
routing, conditional prices and non-token fees can differ from the estimate.

Summarization tokens from [context renewal](context-and-memory.md) appear as
their own subtotal.

Calls to the [image model](models.md#auxiliary-models) count in the Wisp's
totals. The session report lists each image model on its own row, apart from
the same model's conversation turns, with its number of calls instead of
turns. Their cost is the one Pi recorded with each call, not the cached
OpenRouter price, and stays unknown when Pi recorded none. Failed calls that
the provider still reported usage for are included.
In the session report's tool calls, a read that used the image model names
it, or says it came from that model's saved transcription when nothing was
sent again.

