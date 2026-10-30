# Token usage and session reports

## Per-Wisp session report

Open a Wisp's settings and select **Usage** to inspect its current Pi session,
model/token totals, tool status, compactions, and retries. Runtime version and
retry notices are recorded for sessions used by this version of Wisp; older
sessions may not contain them. Tool argument values, file contents, prompts,
and raw provider error details are excluded from reports.

## Runtime events

For debugging, the **Usage** tab of a Wisp or a circle can record the raw
events of the conversation's runtime: Pi's agent events, or the messages the
Claude Code SDK yields. Turn on **Record runtime events**, send a message, and
each event of the reply appears with its time, type and payload. **Copy
events** copies the whole sequence as JSON, to attach to a bug report.

- Recording is off by default and is set per conversation. The conversation
  works the same either way.
- Events stay only in the memory of the computer or server that runs the Wisp,
  up to the latest 1,000 per conversation. Turning recording off, **Clear**, or
  a restart forgets them.
- Long texts are shortened, and values under keys such as `apiKey`,
  `authorization` or `token` are replaced with `[redacted]`. Payloads still
  hold prompts, replies and tool results, so read a copy before sharing it.

## Token usage dashboard

Open **Settings → Token usage** for totals and a breakdown by Wisp over the
last 7 days, 30 days, or all saved history. Refresh reloads the persisted Pi
sessions, including earlier session files and compacted turns, without adding
duplicate usage. History is local and survives app restarts; the dashboard
covers existing Wisps. Deleting a Wisp removes it from this view.

**By model** shows the same usage one row per model, with the turns it
answered and how many Wisps used it. A model's turns and its calls as the
image model share one row; turns a Claude plan paid for have a row of their
own. Context summaries, whose model is not recorded, are a **Context
summaries** row, so the rows add up to the totals. The **Model** menu next to
**Refresh** narrows the summary and both tables to one model; **By Wisp** then
shows each Wisp's use of that model and leaves out Wisps that never used it.
A server older than this version sends no split by model, so the page shows
only **By Wisp** for it.

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

