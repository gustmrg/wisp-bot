# ADR 031: Custom OpenAI-compatible endpoints

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp maintainer, backend and security boundary, renderer
- Scope: Servers the person adds that speak the OpenAI chat completions API,
  such as Ollama, LM Studio, vLLM, llama.cpp, or a proxy, as providers of
  their own
- Related: [ADR 001](001-agent-runtime.md), [ADR 009](009-headless-server.md),
  [ADR 012](012-auxiliary-models.md), [ADR 021](021-fallback-models.md),
  [ADR 026](026-claude-code-runtime.md), SWE-236, SWE-237

## Context

Wisp offered only the providers in Pi's catalog. A model on the person's own
computer, a model server on their network, or a proxy such as LiteLLM could
not run a Wisp. OpenBot and OpenMausBot, two projects with the same idea as
Wisp, both let the person add such an endpoint.

Pi already does the work: a provider registered with
`ModelRuntime.registerProvider` and the `openai-completions` API runs like a
catalog provider, and it resolves a key from the credential store Wisp gives
it. Two of Pi's behaviors shape the design:

- A key in a provider's configuration is not taken literally: `!command` runs
  the command on every request and `$NAME` reads an environment variable. A
  key saved in the credential store is used as it is.
- A provider without any key is not available. Pi's documentation gives local
  servers a placeholder key, which they ignore.

What sets one kind of provider apart is decided in one table,
`shared/provider-kinds.ts` (SWE-236), which the backend and the renderer both
read. An endpoint is a new kind in it.

## Decision

**The person adds an endpoint in Settings → AI Model → Custom endpoints. Each
endpoint is a provider of its own, `custom-` and a random suffix, that Pi runs
on the `openai-completions` API.**

### What an endpoint is

- A name, a base URL, an optional key, and 1 to 50 models. At most 20
  endpoints.
- The base URL is http or https, without credentials, query, or fragment, and
  is kept without a trailing slash.
- Each model has an ID, a context window, an output limit, and whether it
  accepts images, because servers do not report them. New models start at
  32,768 and 8,192 tokens. No model reasons: servers expose reasoning in ways
  that need per-server settings.
- Endpoints are stored in `custom-endpoints.json`, schema version 1, beside
  `ai-settings.json`, so backups carry them. Their keys are kept in the model
  credential store under the endpoint's ID. Each environment keeps its own
  ([ADR 009](009-headless-server.md)).
- Model IDs may contain `_`, as local servers name quantized models
  (`llama3.1:8b-instruct-q4_K_M`); the shared `isModelId` check now allows it
  for every provider.

### Keys and addresses

- The provider configuration given to Pi always carries the placeholder
  `wisp-no-key`. A key the person enters goes to the credential store and the
  runtime key, the same way as other provider keys, and Pi sends it as typed.
  A test sends a key that starts with `!` and contains `$HOME` to a local
  server and checks it arrived unchanged.
- A key is sent to its endpoint's origin only. Model lists are read with
  `redirect: "error"`. Saving an endpoint at another origin with a saved key
  is refused unless the key is entered again or removed. Loading the models
  of a saved endpoint uses its key only at the same origin.
- An endpoint's key is managed in its form. AI Model settings refuse a key
  for an endpoint and refuse to remove one, so the key stays with the address
  it was given for.

### Model lists and local servers

- **Load models** reads `GET <base URL>/models` with a 5-second timeout and at
  most 1 MB, and keeps each valid model ID once, sorted, at most 500.
- **Find local servers** asks the usual addresses of Ollama (`11434`),
  LM Studio (`1234`), vLLM (`8000`), and llama.cpp (`8080`) on `127.0.0.1`,
  without a key, 1.5 seconds each, and lists the ones that answer with a model
  list. It runs only when the person asks.

### Where an endpoint's models go

- The endpoint kind's credential is `optional`: its provider reports
  `credentialConfigured` with or without a key, so it is offered in every
  picker, including fallback and image understanding, which run on Pi.
- Its prices are `unknown`: usage reports show the cost as unknown instead of
  free, since a proxy can charge for what Pi records as zero.
- Saving or removing an endpoint reapplies the global model, as saving AI
  Model settings does. Removing one clears the global model when it used one
  of its models; Wisps, fallbacks, and image models that chose one keep the
  choice and show it as unavailable.

## Consequences

- A Wisp can run on a local model with no account and no key.
- An endpoint behaves as a catalog provider everywhere else: per-Wisp models,
  fallback, image understanding, jobs, circles, and compaction.
- Wisps always send tools. A model without tool calling fails with the
  server's error; the form says to choose models that support it.
- The context window is the person's to set. One larger than the server's
  makes the server cut the request, and Ollama's default window is small.
- The `openai-completions` request shape is Pi's default. A server that needs
  a compatibility setting cannot be configured yet.

## Deferred

- APIs other than `openai-completions`, such as Anthropic- or
  Google-compatible endpoints.
- Custom headers, Pi's per-model compatibility settings, and reasoning
  levels.
- A switch per model for servers without tool calling.
- Looking for local servers automatically, or on other computers of the
  network.

## Decisions taken with the user

- Endpoints come after the provider kinds table, as the second pull request
  of a stack with it (SWE-236, SWE-237).

## Rejected alternatives

- **Writing endpoints to Pi's `models.json`.** Its key field would run
  commands and read environment variables, and the file would hold keys in
  plain text.
- **Putting the person's key in the provider configuration.** Same reason:
  Pi expands it.
- **Following redirects when reading a model list.** A redirect would send
  the key to an address the person never gave.
- **One provider for all endpoints.** Two endpoints could list the same model
  ID, and a key would apply to all of them.
- **Prices of zero.** A proxy's models are not free; an unknown cost is
  honest.
