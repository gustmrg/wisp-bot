# AI models

Wisp conversations run on the [Pi agent runtime](decisions/001-agent-runtime.md)
with a provider API key configured in the app. Only API-key authentication is
offered; keys are encrypted at rest and never returned to the renderer (see
[security](security.md)).

## Global model and provider keys

**Settings → AI Model** manages the default model and encrypted, shared
provider keys. Providers with API-key authentication and models in Pi's
installed catalog are available.

## Models per Wisp

When creating a Wisp, the **Model** section can select another provider/model
and output-token limit for that Wisp, or keep **Use global model** to inherit
the default. Overrides are saved locally with the Wisp and restored on restart;
a Wisp's **Model** tab shows the selection read-only. An invalid override
requires configuration; it does not silently use a different provider. Removing
a provider key disables affected Wisps until the key is restored.

Idle Wisps switch immediately; active Wisps finish their current turn with the
previous model. The conversation header shows the actual model and any pending
change.

## First-time setup

Creating a Wisp without a provider is allowed, but sending is disabled until
configuration is complete. **Configure AI model** opens setup directly, keeping
the unsent draft intact.
