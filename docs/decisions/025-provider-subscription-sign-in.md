# ADR 025: Provider subscription sign-in

- Status: Accepted
- Date: 2026-10-19
- Decision owners: Wisp product, backend and security boundary
- Scope: Paying for Wisp models with a provider subscription instead of an API
  key
- Related: [ADR 001](001-agent-runtime.md), [ADR 009](009-headless-server.md),
  [ADR 018](018-native-mobile-app.md), [models](../models.md),
  [security](../security.md), SWE-148, SWE-182

## Context

Wisp models were reachable only with a provider API key, billed per token.
Many people already pay for a ChatGPT or Claude subscription and want their
Wisps to use it.

Pi ships OAuth sign-ins for several subscriptions, and its model runtime stores
the credential in Wisp's encrypted credential store and refreshes it. They are
not equivalent:

- **OpenAI** (`openai`, "Sign in with ChatGPT") registers the app as its own
  agent client and sends the token to `api.openai.com`. This is OpenAI's
  program for third-party apps to draw on a person's plan.
- **OpenAI Codex (legacy)** (`openai-codex`) reuses the Codex CLI's client ID
  against `chatgpt.com/backend-api`.
- **Anthropic** (Claude Pro/Max) reuses Claude Code's client ID and sends
  requests as Claude Code (`user-agent: claude-cli`, `x-app: cli`, and Claude
  Code's system prompt). Anthropic's terms do not allow third-party apps to
  offer Claude.ai sign-in, route requests through Free, Pro, or Max
  credentials, or store those tokens, and Anthropic enforces this.

Replacing Pi with the providers' SDKs would not help: an SDK does not bring
subscription access, and with Anthropic's SDK it is the same disallowed use.

## Decision

**Wisp offers subscription sign-in through Pi only for providers whose own
program covers third-party apps; today that is Sign in with ChatGPT.**

- An allowlist in `ModelService` names the providers whose sign-in Wisp offers
  (`openai`). Pi's other OAuth sign-ins stay hidden, and a stored sign-in for a
  provider outside the list is not accepted for a selection.
- A provider keeps one credential. Signing in replaces its API key and
  entering a key replaces its sign-in. Settings say which one is saved and that
  a sign-in counts against the plan's usage limits instead of per-token
  billing.
- The sign-in runs in the backend, where Pi listens for the browser's redirect
  on `127.0.0.1:1455`. For a caller on the server's computer, the system browser
  opens there. For any other device (the browser app, a phone, or a desktop app
  connected to a remote server), settings show the page, and the person pastes
  the address the browser lands on. The provider's redirect address is fixed,
  so the loopback relay MCP sign-ins use cannot receive it. A sign-in that has
  not finished after ten minutes is cancelled.
- The installation sends a stable random ID, stored in `ai-settings.json`, as
  its agent host ID.
- Tokens stay in the encrypted credential store, are refreshed by Pi, and never
  reach the renderer.
- Voice input still needs an API key: a sign-in does not count as one there.

Claude subscriptions are a separate question, tracked in SWE-182: the allowed
path is running the unmodified Claude Code binary, signed in by the person, as
a Wisp's agent runtime. That runtime has its own tools and sandbox, so it is not
a model provider in this sense.

## Consequences

- A Wisp on OpenAI models can run on a ChatGPT plan without an API key.
- Pi still sends `Pi` as the agent name hint, so OpenAI's consent screen and
  per-app limits name Pi rather than Wisp until Pi makes it configurable or
  Wisp registers its own client.
- Adding another provider takes a policy check and one allowlist entry.
