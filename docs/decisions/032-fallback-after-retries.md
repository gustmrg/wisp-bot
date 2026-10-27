# ADR 032: Fallback models answer once retries run out

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp product and model runtime
- Scope: When a Wisp's fallback model answers for a failure that may pass,
  such as a rate limit
- Related: [ADR 021](021-fallback-models.md), [ADR 026](026-claude-code-runtime.md),
  [AI models](../models.md#fallback-models), SWE-238

## Context

ADR 021 sends a model call to the Wisp's fallback model only when the model
fails for good: out of credits, a rejected key, a missing model. Failures that
may pass keep Pi's own retries, two of them, and then fail the turn. Those are
the most common: a rate limit, an overloaded provider, a server error, a
dropped connection. The person sees the error, sends the message again, and
often gets the same error, while the fallback they set up sits unused. ADR
021 deferred this case.

OpenBot tries its backup models in order on rate limits, provider outages,
network failures, and timeouts, as long as the turn has not written text or
run a tool yet. Hermes Agent switches after its retries on rate limits and
server errors.

## Decision

**A failure that may pass moves to the fallback once the runtime's own
retries have run out**, on the failure that would otherwise end the turn.

- `ModelFallback` takes the number of retries Pi makes (`retries`, 2, the
  value of the session's retry setting). It counts the calls of the Wisp's
  model in a row that failed in a way Pi retries (`isRetriedFailure`: Pi's
  `isRetryableAssistantError`, without context overflows). The failure after
  the retries goes to the fallback; the earlier ones go back to Pi, which
  waits and retries as before.
- The count starts over when the model answers, when the fallback answers,
  and with each turn, as Pi's own retry count does. A call that moved to the
  fallback ends Pi's retries as a success.
- Everything else of ADR 021 holds: only a call that fails before answering
  moves, so nothing written is replaced; the switch lasts for the rest of the
  turn; a request too large for the model never moves.
- Claude Code retries a failing provider on its own before it fails the turn.
  `movesToFallback` now also sends a turn that failed with a provider error
  that may pass (`isRetryableProviderError`, such as `API Error: 529
  overloaded`) to the fallback; a failure of Claude Code itself, such as
  reaching its turn limit, does not move.

## Consequences

- A Wisp with a fallback answers through a rate limit or an outage of its
  provider, after the few seconds of Pi's retries.
- A Wisp without a fallback fails as before.
- Each turn tries the Wisp's own model again, with its retries. A provider
  that stays limited costs those seconds on every message, which is
  acceptable while outages last minutes.

## Deferred

- Staying on the fallback until the provider's limit resets.
- A list of fallback models tried in order.
- Claude Code job runs, which do not fall back at all yet.

## Decisions taken with the user

- Implement SWE-238 after SWE-239, as the next issue of the plan.
- Ship this step alone. Holding a model until its limit resets and a list of
  fallbacks were built, but are left out: on the person's server, the
  provider outages of October lasted a few minutes, and the one fallback
  never failed.

## Rejected alternatives

- **Falling back at the first failure that may pass.** A short rate limit
  often passes within Pi's retries, and the Wisp's own model is the one the
  person chose.
- **Lowering Pi's retries to reach the fallback sooner.** Wisps without a
  fallback would lose retries that often succeed.
- **Telling failures apart again in Wisp.** Pi already classifies which
  failures it retries; following it keeps the two in step.
