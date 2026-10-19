# AI models

Wisp conversations run on the [Pi agent runtime](decisions/001-agent-runtime.md)
with a provider API key configured in the app, or on Claude Code with the
person's own Claude plan (see [Claude Code](#claude-code)). Keys are encrypted
at rest and never returned to the renderer (see [security](security.md)).

## Global model and provider keys

**Settings → AI Model** manages the default model and encrypted, shared
provider keys. Providers with API-key authentication and models in Pi's
installed catalog are available. The app starts from the catalog cached on disk
and refreshes it over the network in the background (for at most ten seconds),
so an offline or slow connection never delays the window; a refresh failure is
shown in these settings.

These settings pick a provider first and then one of its models, because the
provider also decides which API key the page edits, and every provider in the
catalog is listed whether or not it has a key yet. The other model pickers
(Wisp creation, a Wisp's **Model** tab, fallback and image understanding) choose
among models that can already run, so they list the models of every provider
with a saved key in one searchable list, each with its provider and ID.

Model pickers show the logo of the lab that made each model, which is not
always the provider serving it (Claude through OpenRouter shows Anthropic's).
The lab comes from the model family or vendor prefix in the model ID, or from
the provider when a lab runs it; models from other labs and routers that pick
the model themselves show no logo.

## Claude Code

The **Claude Code** provider runs Wisps on the person's own Claude Code and
Claude plan, through the official Claude Agent SDK
([ADR 026](decisions/026-claude-code-runtime.md)). Wisp never asks for a Claude
password or token.

- **Setup:** install Claude Code on the computer that runs Wisp (the desktop
  app's computer, or the server for a remote or headless Wisp), then sign in
  there with `claude auth login`. On a headless server, sign in over SSH by
  pasting the code the browser shows, or run `claude setup-token` and set
  `CLAUDE_CODE_OAUTH_TOKEN` in the server's service environment.
- **Status:** **Settings → AI Model**, with Claude Code chosen, shows whether
  it is installed, recent enough, and signed in, and with which plan. Claude
  Code must be at least the version the Agent SDK Wisp ships was built with;
  `claude update` brings an older one up to date. **Check again** reads the
  status after a fix.
- **Models:** `default`, `opus`, `sonnet`, and `haiku`. Claude Code resolves
  them to the newest model it knows. Fable is not offered, because it can bill
  usage credits instead of the plan. The reasoning level sets Claude Code's
  effort. Claude Code manages its own output limit, so none is set here.
- **Tools:** a Claude Code Wisp has the same tools as on Pi (files in its
  workspace, commands in its container, skills, jobs, Wisp management,
  plugins, and MCP servers), with the same approvals. Claude Code's own tools,
  such as Bash, are never offered, and its user and project settings, hooks,
  and claude.ai connectors are not loaded.
- **Usage:** replies count against the plan's usage limits.
- **History:** Claude Code keeps its own conversation under `~/.claude/` on
  that computer and deletes conversations unused for 30 days. The next message
  after that starts a new Claude Code conversation that is told the latest
  messages. The Wisp's own transcript stays the record that is shown, searched,
  and backed up.
- **Context:** the Wisp's **Context** tab works as on Pi: **Compact** asks
  Claude Code to summarize the conversation, **New topic** starts a new Claude
  Code conversation, and the renewal policy and memory apply the same way.
  Claude Code keeps its summary to itself, so none is shown.
- **Jobs:** scheduled jobs run on Claude Code too, one turn each, and Claude
  Code keeps nothing from them.

## Models per Wisp

When creating a Wisp, the **Model** picker keeps **Use the global model** to
inherit the default, or selects a model for that Wisp. A Wisp's **Model** tab
shows the model in use and changes it at once, with the output-token limit
under **Advanced**; a template's limit is kept on creation. Overrides are saved
locally with the Wisp and restored on restart. An invalid override requires
configuration; it does not silently use a different provider. Removing a
provider key disables affected Wisps until the key is restored.

Idle Wisps switch immediately; active Wisps finish their current turn with the
previous model. The conversation header shows the actual model and any pending
change.

## Fallback models

A fallback model answers when a Wisp's model fails for good before answering,
for example when the provider is out of credits, rejects the key, or no longer
serves the model ([ADR 021](decisions/021-fallback-models.md)). Errors Pi
retries, such as rate limits and server errors, and requests too large for the
model do not move to the fallback.

**Settings → AI Model → Fallback** chooses the global fallback; it is **Off**
by default. A Wisp's **Model** tab chooses **Off**, **Use the global
fallback**, or a model of its own. A Wisp on the global model uses the global
fallback until it chooses; a Wisp with its own model has none until it is
turned on. Only models from providers with a saved key are listed.

Once the fallback answers, it answers for the rest of that turn; the next
message tries the Wisp's model again. The fallback takes the output limit and
reasoning level of the model it stands in for, reduced to what it supports.
The Wisp's activity says when the fallback is answering, each reply it wrote
carries a **Fallback** badge, and the session report lists the switch. A
fallback whose key is removed or whose model leaves the catalog stays saved
but is not used, and the setting says why.

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
