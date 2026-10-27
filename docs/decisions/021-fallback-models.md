# ADR 021: Fallback models

- Status: Accepted
- Date: 2026-10-15
- Decision owners: Wisp product and model runtime
- Scope: A model that answers for a Wisp when its own model fails for good
- Related: [AI models](../models.md), [ADR 001](001-agent-runtime.md), [ADR 012](012-auxiliary-models.md)

## Context

A Wisp runs on the global model or on a model of its own. When that model's
provider stops serving it for good (the account is out of credits, the key is
rejected, the model is withdrawn) every message fails, and the Wisp cannot be
used until the person changes the global model or, for a Wisp with its own
model, creates the Wisp again, since its model cannot be changed afterwards.

Hermes Agent keeps sessions going with a chain of fallback providers. It
switches at once on credit, key, and missing-model errors, and after its
retries on rate limits and server errors. The switch lasts for the turn: each
new message tries the primary model again
([Hermes Agent: fallback providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers)).

## Decision

Wisp gets **fallback models**: a global fallback, and a per-Wisp choice.

### Settings

- **Settings → AI Model → Fallback** chooses the global fallback model, or
  **Off** (the default). It lists models from providers with a saved key,
  except the global model itself. It names a provider and model only: a
  fallback takes the output limit and reasoning level of the model it stands
  in for, reduced to what it supports.
- A Wisp's **Model** tab chooses its fallback: **Off**, **Use the global
  fallback**, or a model of its own. A Wisp on the global model uses the
  global fallback until it chooses; a Wisp with its own model has none until
  the person turns it on, because the person chose that model on purpose.
- The global choice lives in `ai-settings.json` as an optional field of
  version 1, like the auxiliary models. A Wisp's choice lives in its row in
  `conversations.sqlite` (layout version 11); a Wisp from before has none, so
  it follows its model.
- A saved fallback whose key is removed, or whose model leaves the catalog,
  stays saved but is not used, and the setting says why.

### When it answers

A model call moves to the fallback when it fails **before answering** with an
error **Pi does not retry** (`isRetryableAssistantError` is false): out of
credits or over a quota (whatever the status: OpenAI says so with a 429,
Anthropic with a 400), a rejected key, a forbidden or missing model, a
rejected request. A request too large for the model does not move, since
compaction fixes it. Rate limits and server errors keep Pi's own retries, and
move once those run out ([ADR 035](035-fallback-after-retries.md)).

The rule follows Pi's classification rather than a list of statuses kept by
Wisp, so it changes with Pi.

### Runtime

- The session's stream function is wrapped (`backend/model-fallback.ts`).
  Every model call of the session, compaction included, goes through it; cache
  warming does not, so warming never reaches the fallback.
- The wrapper holds back the model's opening event until it answers, so a call
  that fails first can be replaced by the fallback's call in the same stream.
  The turn goes on, mid tool loop included, and only the fallback's reply is
  kept in the session.
- After a switch, the rest of the turn goes to the fallback without trying the
  Wisp's model again; each new message starts on the Wisp's model. A Wisp
  moves at most once per turn, and a failing fallback reports its own error.
  ADR 035 changed this: a failing fallback hands over to the next in the
  global list, and a model on hold is not tried until its hold ends.
- The fallback is read when a call fails, so a changed choice applies without
  rebuilding the session. A fallback equal to the model that failed is none.
- Credentials resolved for the Wisp's provider are not sent to a fallback of
  another provider, and the request hook shapes the payload for the
  fallback's provider (OpenRouter reasoning options).
- Pi keeps the session on the Wisp's model, so compaction still uses that
  model's context window. A fallback with a smaller window can fail a long
  conversation; that is accepted for now.

### What the person sees

- While the fallback answers, the Wisp's activity says so.
- Each reply the fallback wrote carries a **Fallback** badge naming the model.
- The session report lists the switch, and token usage is reported under the
  fallback model.
- A provider out of credits is described as such instead of as rate limiting.

## Alternatives considered

- **A fixed list of statuses (401, 402, 403, 404).** Misses credit errors that
  use other statuses, such as OpenAI's 429 `insufficient_quota` and
  Anthropic's 400 for a low credit balance.
- **Switching after the failed turn and asking the person to send again.**
  Pi has no public way to continue a failed turn, and sending the message
  again would repeat it in the history.
- **Wrapping the model runtime given to Pi.** Cache warming calls it too, and
  would reach the fallback.
- **A chain of fallbacks.** One per scope covers the reported problem; the
  settings file can grow into a list later. It did, for the global fallback:
  [ADR 035](035-fallback-after-retries.md).

## Deferred

- Falling back after Pi's retries on rate limits and server errors run out:
  done in [ADR 035](035-fallback-after-retries.md).
- Staying on the fallback until a rate limit's reset time, as Hermes does.
- Sizing the conversation to the fallback's context window.
