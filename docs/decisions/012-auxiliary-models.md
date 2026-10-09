# ADR 012: Auxiliary models

- Status: Accepted
- Date: 2026-10-08
- Decision owners: Wisp product and model runtime
- Scope: A second, user-chosen model that does one task the Wisp's own model cannot
- Related: [AI models](../models.md), [token usage](../token-usage.md), [security](../security.md),
  [ADR 001](001-agent-runtime.md)

## Context

A Wisp's `read` tool attaches images, and the pages of a PDF without a text
layer (usually scans), as image blocks. Pi drops those blocks when the model
lacks image input, so a Wisp on a text-only model cannot read photos, receipts,
screenshots, or scanned documents. The app says so in the model pickers, the
Wisp's Model tab, and the composer, but offers no way around it short of
changing the model.

Text-only models are common choices because they are cheap or strong at other
work. Hermes Agent solves the same problem with auxiliary model slots: side
tasks such as vision are routed to a separately configured model, and left on
the main model by default
([Hermes Agent: configuring models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models)).

## Decision

Wisp gets **auxiliary models**: per-task model selections, kept separate from
the model that runs conversations. The first and only task in this decision is
**image understanding**, and its only use is transcription inside the `read`
tool.

The image model is used only when a Wisp's own model lacks image input. A Wisp
whose model can see images keeps sending images to it, and the auxiliary model
is never called. A model missing from the catalog counts as lacking image
input, as it does for PDF pages today.

## Settings

- **Settings → AI Model → Auxiliary models → Image understanding** chooses a
  provider and model, or **Off** (the default). The list shows only models whose
  catalog entry includes `image` input, from providers with a saved key. Keys
  stay shared with the rest of the app; there is no separate key field.
- The selection is global. A per-Wisp choice is deferred.
- The copy under the picker says that images and scanned pages from Wisps on
  text-only models are sent to the chosen provider.
- `ai-settings.json` keeps `schemaVersion: 1` and gains an optional
  `auxiliary: { imageUnderstanding: ModelSelection | null }`. Files without it
  read as off. A version 2 was rejected: earlier versions discard any file whose
  version they do not know, which would lose the main model selection after a
  downgrade. An earlier version that saves settings drops `auxiliary`, and the
  slot reads as off again.
- The selection is validated like the main one. A selection whose provider
  loses its key or whose model leaves the catalog is treated as off, not
  replaced with another model, and the picker shows it as unavailable with the
  reason.

## Runtime

The backend calls the auxiliary model with `ModelRuntime.completeSimple`, so
provider auth, request formats, and usage reporting are the ones Pi already uses
for conversations. Each call has an output limit of 4,096 tokens and the turn's
abort signal.

- **What is sent:** when the Wisp's model lacks image input and the slot is
  configured, `read` sends an image file, or a PDF page rendered for lack of
  text, to the auxiliary model with a fixed prompt: transcribe all visible text,
  keep tables as tables, then describe the rest of the content. The tool returns
  that text in place of the image, labeled with the provider and model that
  produced it. The PDF reader gains this third mode next to "attach page
  images" and "report scanned pages".
- **Limits per read:** at most five images or pages, as for page images, with
  up to three auxiliary calls at a time and one 90-second deadline shared by the
  whole read. The text budget for one read is checked before each call, so no
  call is made for a page that would not fit. When the deadline passes, the read
  returns the pages that finished, notes which pages were not transcribed in
  time, and says where to continue (`offset=N`), the same way it pages a long
  PDF.
- **Activation:** `read` checks the slot at call time, so a settings change
  applies from the next tool call. No tool is added or removed, so the session's
  tool set and prompt cache are unaffected.
- **Untrusted content:** text produced from an image is data from the user's
  file, not instructions. The tool result says so, like `search_history` and
  web results.
- **Failures:** if the slot is off, or the provider fails or times out, the tool
  result explains that the image or page could not be read, as today. A failed
  auxiliary call never fails the Wisp's turn.

## Transcription cache

Transcriptions are cached so that reading the same file again, after a context
renewal or while paging a PDF, does not call the provider again.

- **Key:** a hash of the file's content, the provider, the model, the page
  (none for images), and a version of the fixed prompt. A changed file, model,
  or prompt misses the cache; its old entries are never used again.
- **Location:** a cache directory in the Wisp's configuration directory
  (`pi-config/<storageId>`), next to its skills. It does not count toward the
  workspace quota, and the Wisp's `ls`, `find`, and `read` cannot see it.
- **Eviction:** on each write, entries unused for 30 days are removed, then the
  oldest entries until the cache is under 20 MB.
- **Deletion and backups:** the cache is deleted outright when its Wisp is
  deleted, not moved into the deleted-Wisp archive, and backups exclude it. It
  holds text from the user's documents and can be rebuilt.
- A cache hit sends nothing to the provider and records no usage.

## Usage and cost

Each auxiliary call, including one that fails after the provider reported
usage, appends a `wisp:auxiliary-usage` custom entry to the Wisp's Pi session
with the task, provider, model, outcome, and the usage and cost Pi returned.
Image content, prompts, and answers are not recorded.

The session report and **Settings → Token usage** count these entries in the
Wisp's totals. Each auxiliary model gets its own model row, kept apart from the
same model's conversation turns and marked as auxiliary. These rows do not count
turns, and their cost is the one Pi recorded, not the cached OpenRouter price,
like context-renewal summaries. A call without a recorded cost leaves the cost
unknown, not zero.

## User-facing hints

- While a read uses the auxiliary model, the tool's activity names the provider
  and model and shows progress, for example "Reading with OpenAI GPT-5 mini,
  page 2 of 5…". This needs a label carried on the tool's update event; the
  activity labels in the tool catalog are fixed per tool.
- The finished tool card stays in the conversation history and says the content
  was read with that provider and model, or taken from its saved transcription
  on a cache hit. A failure adds nothing to the card; the tool result explains
  it to the Wisp.
- With the slot configured, the composer says that attached images will be
  read by the auxiliary model, instead of saying they cannot be read.
- The Wisp's Model tab names the auxiliary model next to the no-image-input
  note.

## Alternatives considered

- **Local OCR** (for example `tesseract.js`): works offline and costs nothing
  per call, but adds large language data, reads layouts and handwriting poorly,
  and cannot describe non-text content. It may still be worth adding later as a
  private, offline fallback.
- **Switching the Wisp's model for the turn:** loses the conversation's prompt
  cache and model-specific behavior, and silently changes which model answers.
- **Sending images to the Wisp's model anyway:** providers reject them or
  ignore them.

## Deferred

- An `analyze_image` tool that asks the auxiliary model a specific question
  about one image, for when a generic transcription misses what the user asked
  about.
- Other auxiliary tasks: context-renewal summaries, conversation titles, and
  web-page summaries on a cheaper model.
- A per-Wisp image model, and using the auxiliary model even when the Wisp's
  model can see images (to save cost).
- Audio and video input.
