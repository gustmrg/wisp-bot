# ADR 035: Fallback models answer once retries run out, until limits reset

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp product and model runtime
- Scope: When a Wisp's fallback model answers for a failure that may pass,
  such as a rate limit, and how long the Wisp stays on it
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

### Holding a model until its limit resets

**A model that kept rate limiting or failing after the retries is held, and
while it is held, turns of Wisps with a fallback start on the fallback.**

- `ModelHolds` (`backend/model-holds.ts`) keeps, in memory, until when each
  model (provider and model ID) is held. One instance serves the backend:
  Pi's sessions, job runs included, and Claude Code's.
- `holdAfter` decides from the error: `providerFailureCause` says
  `rate_limit` or `provider_unavailable`, and the hold lasts until the time
  the provider named ("try again in 20s", read by `retryAfterMs`), or
  `MODEL_HOLD_MS`, 10 minutes. Credits, keys, a request too large, and
  network failures do not pass with time, so they hold nothing.
- `ModelFallback` holds the model when Pi's retries ran out on such a
  failure. A call on a held model starts on the fallback at once, without
  retries; a Wisp without a fallback keeps calling its model as before. Once
  the hold ends, the next turn starts on the Wisp's own model.
- A Claude Code plan limit holds its model until the plan's full window
  resets (`planResetAt`, from Claude Code's `rate_limit_event`), and a
  provider that kept failing after Claude Code's retries holds it as above.
  A turn on a held Claude Code model goes to the fallback without starting a
  Claude Code process.
- The fallback's notice carries the end of the hold (`until`), and the
  conversation reads "The model is limited. Answering with the fallback
  model until 17:30…".
- Restarting the backend ends every hold.

## Consequences

- A Wisp with a fallback answers through a rate limit or an outage of its
  provider, after the few seconds of Pi's retries.
- A Wisp without a fallback fails as before.
- While a model is held, Wisps with a fallback answer at once instead of
  waiting through retries on every message, and come back to their model
  when the hold ends.
- A hold covers every Wisp of the environment on that model, since a rate
  limit applies to the account's key, not to one Wisp.
- A provider that recovers early is not tried until the hold ends.

## Deferred

- Keeping holds across a restart of the backend.
- Reading the `retry-after` header, which Pi does not pass on.
- A list of fallback models tried in order.
- Claude Code job runs, which do not fall back at all yet.

## Decisions taken with the user

- Implement SWE-238 after SWE-239, as the next issue of the plan.

## Rejected alternatives

- **Falling back at the first failure that may pass.** A short rate limit
  often passes within Pi's retries, and the Wisp's own model is the one the
  person chose.
- **Lowering Pi's retries to reach the fallback sooner.** Wisps without a
  fallback would lose retries that often succeed.
- **Telling failures apart again in Wisp.** Pi already classifies which
  failures it retries; following it keeps the two in step. Causes are read
  from the error text only to decide how long a model is held.
- **A hold per Wisp.** A rate limit applies to the provider account, so every
  Wisp on the model would hit it in turn.
- **Saving holds to disk.** A restart is rare, and trying the model again
  after one costs one turn's retries.
