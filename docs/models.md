# AI models

Wisp conversations run on the [Pi agent runtime](decisions/001-agent-runtime.md)
with a provider API key or, for OpenAI, a ChatGPT subscription sign-in
configured in the app, or on Claude Code with the person's own Claude plan (see
[Claude Code](#claude-code)). Credentials are encrypted at rest and never
returned to the renderer (see [security](security.md)).

## Global model and provider keys

**Settings → AI Model** chooses the default model, and **Settings → Providers**
manages encrypted, shared provider keys. A key is added on its own, so adding
one never changes a model. **AI Model** lists models only from connected
providers. Providers with API-key authentication and models in Pi's
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

## Subscription sign-in

For OpenAI, **Settings → Providers → OpenAI → Sign in with ChatGPT** uses the
person's ChatGPT plan instead of an API key: requests count against the plan's
usage limits rather than being billed per token
([ADR 025](decisions/025-provider-subscription-sign-in.md)). Other providers'
subscription sign-ins that Pi has are not offered, because they sign in as
another vendor's own client; a Claude plan runs Wisps through
[Claude Code](#claude-code) instead.

- In the desktop app on the server's computer, the system browser opens and the
  sign-in completes on its own.
- In the browser app, on a phone, or in a desktop app connected to a remote
  server, settings show **Open the sign-in page**. After approving, the browser
  goes to an address starting with `http://127.0.0.1:1455` that does not load;
  paste it into **Address after sign-in**.
- A provider's models use one credential: signing in replaces its API key, and
  entering a key in **Providers** replaces the sign-in. **Sign out**
  removes the sign-in, and Wisps on that provider stop until it is restored.
- Voice input needs an OpenAI API key; the sign-in does not reach it. Signing
  in keeps the saved API key for voice input, and a key saved in Voice input
  settings while signed in is kept for voice input alone, beside the sign-in.
  Removing that key never signs out. Once a key is entered in **Providers**,
  voice input uses that one.
- The backend stores the tokens encrypted and refreshes them.
- Only one sign-in can run at a time, and it is cancelled after ten minutes.
  Pi listens on port 1455 on the server's computer, so an unfinished Codex CLI
  login there blocks it.

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
- **Status:** **Settings → Providers → Claude Code** shows whether
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
  and claude.ai connectors are not loaded. The one exception is web search:
  in the Wisp's **Access** tab, **Search the web** can be **Claude (included
  in your plan)**, which needs no search plugin
  ([plugins](plugins.md#per-wisp-access)).
- **Usage:** replies count against the plan's usage limits. The Wisp's
  session report and **Token usage** count their tokens. Turns on a plan
  cost nothing more and carry a **Claude plan** badge. Claude Code's status
  shows the plan's 5-hour and weekly usage once one is three-quarters used.
- **History:** Claude Code keeps its own conversation under `~/.claude/` on
  that computer and deletes conversations unused for 30 days. The next message
  after that starts a new Claude Code conversation that is told the latest
  messages. The Wisp's own transcript stays the record that is shown, searched,
  and backed up. Deleting the Wisp also deletes what Claude Code keeps for it
  (`claude purge`).
- **Context:** the Wisp's **Context** settings work as on Pi: **Compact** asks
  Claude Code to summarize the conversation, **New topic** starts a new Claude
  Code conversation, and the renewal policy and memory apply the same way.
  Claude Code keeps its summary to itself, so none is shown.
- **Jobs:** scheduled jobs run on Claude Code too, one turn each, and Claude
  Code keeps nothing from them.
- **Fallback:** when Claude Code is signed out or the plan's usage limit is
  reached, the Wisp's [fallback model](#fallback-models) answers that turn,
  told the latest messages of the conversation. Other failures do not move
  to the fallback.
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

A fallback model answers when a Wisp's model fails before answering
([ADR 021](decisions/021-fallback-models.md),
[ADR 032](decisions/032-fallback-after-retries.md)):

- at once when it fails for good, for example when the provider is out of
  credits, rejects the key, or no longer serves the model;
- after the retries when it keeps failing in a way that may pass, such as a
  rate limit, an overloaded or failing server, or a dropped connection. Pi
  retries twice, and Claude Code retries on its own first.

A request too large for the model does not move to the fallback; compaction
shortens it instead.

**Settings → AI Model → Fallback** chooses the global fallback; it is **Off**
by default. A Wisp's **Model** tab chooses **Off**, **Use the global
fallback**, or a model of its own. A Wisp on the global model uses the global
fallback until it chooses; a Wisp with its own model has none until it is
turned on. Only models from other providers with a saved key are listed: a
provider that is down, rate limited, out of credits, or rejecting its key fails
all of its models at once, so a fallback from the same provider would fail
along with the model it stands in for. The global fallback is judged against
the global model, and a Wisp's fallback against the Wisp's model. A Wisp with
its own model on the global fallback's provider has no fallback from it, and
its **Model** tab says so.

Once the fallback answers, it answers for the rest of that turn; the next
message tries the Wisp's model again. The fallback takes the output limit and
reasoning level of the model it stands in for, reduced to what it supports.
The Wisp's activity says when the fallback is answering, each reply it wrote
carries a **Fallback** badge, and the session report lists the switch. A
fallback whose key is removed, whose model leaves the catalog, or that is from
the provider of the model it stands in for, for example after that model
changed, stays saved but is not used, and the setting says why.

## Auxiliary models

Some models cannot see images. **Settings → AI Model → Background tasks →
Reading images** chooses a second model that reads images for Wisps on
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

### Decision model

**Settings → AI Model → Background tasks → Decision model** chooses a model that
decides which Wisp answers a message that mentions no one in a
[circle](circles.md#who-answers). It is **Off** by default, and there is one for
the whole app. Decision models only choose among options and cannot write text,
so they are listed apart from every other model. Only models from providers with
a saved key are listed.

The message, the circle's recent messages, and a description of its Wisps go to
the chosen provider. A model whose key is removed, or that leaves the catalog,
stays saved but is not used, and the setting says why.

A provider that offers only decision models, such as TypeSafe, is connected in
**Settings → Providers** like any other, where it says it offers only them.

## First-time setup

Creating a Wisp without a provider is allowed, but sending is disabled until
configuration is complete. **Configure AI model** opens setup directly, keeping
the unsent draft intact.
