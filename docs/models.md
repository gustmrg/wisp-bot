# AI models

Wisp conversations run on the [Pi agent runtime](decisions/001-agent-runtime.md)
with a provider API key configured in the app. Only API-key authentication is
offered; keys are encrypted at rest and never returned to the renderer (see
[security](security.md)).

## Global model and provider keys

**Settings → AI Model** manages the default model and encrypted, shared
provider keys. Providers with API-key authentication and models in Pi's
installed catalog are available. The app starts from the catalog cached on disk
and refreshes it over the network in the background (for at most ten seconds),
so an offline or slow connection never delays the window; a refresh failure is
shown in these settings.

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

## Auxiliary models

Some models cannot see images. **Settings → AI Model → Auxiliary models →
Image understanding** chooses a second model that reads images for Wisps on
such models ([ADR 012](decisions/012-auxiliary-models.md)). It is **Off** by
default, lists only models that accept images from providers with a saved key,
and is used only while a Wisp's own model lacks image input.

When the Wisp's `read` tool opens an image, or a PDF page without a text layer
(usually a scan), the image goes to the chosen model, which returns a
transcription of its text and a description of the rest; the Wisp receives
that text, labeled with the model that produced it, in place of the image. One
read sends at most five images or pages, three at a time, within 90 seconds;
pages that do not finish in time are named so the Wisp can read them again.
A failed or slow image model never fails the Wisp's turn.
While it reads, the Wisp's activity names the image model and the page it is
on. With an image model chosen, the composer says it will read attached images
for the Wisp, and the Wisp's **Model** tab names it next to the no-image note.

Transcriptions are cached in the Wisp's configuration directory, keyed by the
file's contents, the model, and the page, so reading a file again does not
send it again. Entries unused for 30 days are removed, and the oldest go first
above 20 MB. The cache is deleted with its Wisp and left out of backups. Each
call's token usage is recorded in the Wisp's session.

If the chosen model's provider key is removed, or the model leaves the catalog
or stops accepting images, the choice stays saved but is not used, and the
setting says why.

## First-time setup

Creating a Wisp without a provider is allowed, but sending is disabled until
configuration is complete. **Configure AI model** opens setup directly, keeping
the unsent draft intact.
