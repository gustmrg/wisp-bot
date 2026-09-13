# Wisp Bot

Wisp Bot is an Electron desktop application for running persistent AI-agent conversations. Its React renderer manages the workspace UI while a sandboxed Electron boundary owns conversations, model and plugin credentials, agent sessions, tool authorization, and durable backend state.

<p align="center">
  <img src="docs/screenshot.png" alt="Wisp Bot app screenshot" width="800" />
</p>

The renderer uses React 19, TypeScript 7, Vite 8, Tailwind CSS 4, and locally owned shadcn/ui components with the Base Nova preset.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22.19 or later
- npm

Install dependencies and start the desktop development environment:

```bash
npm install
npm run dev
```

`npm run dev` starts Vite with React Fast Refresh and opens Electron. The Vite URL alone is only a renderer preview; it deliberately cannot access the secure desktop bridge.

For an explicit local fake-agent run that never contacts a provider, start development with `WISP_AGENT_MODE=fake npm run dev`. Packaged builds ignore this switch.

### Quality gates

```bash
npm test
npm run lint
npm run format:check
npm run typecheck
npm run build
```

Use `npm run format` to apply the repository's Biome formatting rules. `npm start` runs a production build and opens the locally built Electron application.

Tests use fake agents and never contact a model provider. CI runs the test, lint, formatting, typechecking, and build gates.

### Optional live Pi smoke

The opt-in smoke test makes one real provider request. It reads the key only from the process environment, does not print model output or key material, and removes its temporary session afterward.

```bash
WISP_PI_SMOKE=1 \
WISP_PI_SMOKE_PROVIDER=anthropic \
WISP_PI_SMOKE_MODEL=claude-sonnet-4-5 \
WISP_PI_SMOKE_API_KEY='your-key' \
npm run smoke:pi
```

### Add shadcn components

```bash
npm run ui:add -- card
```

Generated components are written to `src/components/ui/` and are maintained locally.

## Architecture

- `src/components/` contains renderer presentation. `src/App.tsx` only composes the primary panels and dialogs.
- `src/features/workspace/` owns the renderer workspace controller and integrity-preserving actions. `src/hooks/use-conversations.ts` adapts the typed desktop bridge into React state and streamed events.
- `src/features/persistence/` validates and persists local UI preferences with observable failure handling.
- `shared/` defines process-safe conversation, tool-policy, and IPC contracts used on both sides of the Electron boundary.
- `electron/backend/` owns durable conversations, model configuration, Pi sessions, plugin connections and per-Wisp grants, the fake test gateway, encrypted credentials, and tool authorization. `electron/ipc/` validates and registers the narrow bridge handlers.
- `electron/security-policy.ts`, `electron/main.ts`, and `electron/preload.ts` enforce the renderer trust boundary: sandboxing and context isolation stay enabled, navigation and permissions default to deny, and exposed APIs are typed and sender-checked.

## Current behavior

Wisp conversations are connected to persistent application-managed Pi sessions when a model and encrypted API key are configured. Read-only workspace tools are available; file creation and modification pass through main-process policy and user approval. The fake agent implementation remains as a deterministic test adapter, not the production renderer transport.

Conversations and backend policy are stored under Electron's user-data directory. Unpackaged dev runs redirect that directory to `wisp-bot-dev` (override with the `WISP_DATA_DIR` environment variable) so testing never touches the installed app's data. Theme, timezone, microphone selection, launch-at-login, notification-sound, and related UI preferences are stored locally in the renderer. Theme, auto-review policy, and notification sounds affect current behavior: the renderer plays a synthesized chime when a Wisp finishes its turn and a second tone when one awaits a tool approval, each gated by the app-level "Notification sounds" setting and the per-Wisp notification toggle. Microphone capture, launch-at-login, sign-out, and shortcuts are not connected yet. Installed releases expose explicit check, download, and restart-to-install update states in About. Circles are feature-flagged and do not run their own model sessions.

API keys are encrypted with Electron's operating-system-backed `safeStorage` API; saved keys are never returned to the renderer. Wisp refuses to persist keys when secure storage is unavailable. Unknown file actions are blocked; conflicting auto-review rules use `block` → `ask` → `allow` precedence. Linear writes require separate, single-use approval regardless of file auto-review rules.

Signed Windows and macOS packaging is configured for the protected release workflow. See [the release runbook](docs/release-runbook.md) for its credential boundary, draft-only staging flow, verification, and rollback procedure. No public release is created automatically.

## Project structure

```text
wisp-bot/
├── .github/workflows/ci.yml       # Repository quality gates
├── electron/
│   ├── backend/                   # Persistence, services, agents, and authorization
│   ├── ipc/                       # Validated main-process IPC handlers
│   ├── main.ts                    # Window lifecycle and trust-boundary wiring
│   ├── preload.ts                 # Sandboxed typed renderer bridge
│   └── security-policy.ts         # Pure URL, permission, and CSP policy
├── shared/                        # Cross-process contracts and domain types
├── src/
│   ├── components/                # Renderer feature and UI components
│   ├── config/                    # Application metadata
│   ├── features/persistence/      # Validated local preference persistence
│   ├── features/workspace/        # Workspace controller and domain actions
│   ├── fixtures/                  # Demo-only identity and initial data
│   ├── hooks/                     # Conversation and interaction adapters
│   ├── lib/                       # Renderer policies and pure helpers
│   ├── App.tsx                    # Top-level renderer composition
│   └── main.tsx                   # Renderer entry point and bridge guard
├── tests/                         # Electron/backend and contract tests
├── template/                      # Non-runtime prototype/reference material
├── index.html                     # Renderer HTML and generated CSP slot
└── vite.config.mts                # Renderer build and development policy
```

Maintained runtime code lives in `src/`, `shared/`, and `electron/`. Nothing under `template/` is imported into the application or treated as production source.

## Contributing

Run all quality gates before opening a change. Found a bug or have an idea? [Open an issue](https://github.com/gustmrg/wisp-bot/issues).

## Desktop releases

Release targets, signing custody, staged channels, and rollback policy are defined in `docs/decisions/002-distribution.md`. `npm run dist:dir` creates an unpacked local application for inspection; native signed installers are produced only by the protected `Desktop release` workflow. The workflow defaults to artifact-only mode and cannot create even a draft GitHub release unless its explicit input and release-environment approval are both provided. Public promotion remains a manual operation.

## License

[MIT](LICENSE)

### Session activity and token usage

Open a Wisp's settings and select **Usage** to inspect its current Pi
session, model/token totals, tool status, compactions, and retries. Runtime
version and retry notices are recorded for sessions used by this version of Wisp;
older sessions may not contain them. Tool argument values, file contents, prompts,
and raw provider error details are excluded from reports.

Open **Settings → Token usage** for totals and a breakdown by Wisp over the last
7 days, 30 days, or all saved history. Refresh reloads the persisted Pi sessions,
including earlier session files and compacted turns, without adding duplicate
usage. History is local and survives app restarts; the dashboard covers existing
Wisps. Deleting a Wisp removes it from this view.

USD values are estimates using the latest cached OpenRouter model pricing, not
historical invoices. The pricing cache is schema-versioned, refreshed daily, and
its update time is shown. Input, output, cache reads, and cache writes are counted
separately. Missing model/cache-write pricing yields an unknown cost, rather than
zero. Prices follow the [OpenRouter model pricing fields](https://openrouter.ai/docs/guides/overview/models);
routing, conditional prices and non-token fees can differ from the estimate.
Unreadable or oversized session files produce an explicit partial-history warning.

### Responsive mobile layout

At viewport widths up to 760px the renderer shows one screen at a time: the
conversation list, an active chat, or Wisp settings. The list includes live
Unread and Active filters and a bottom navigation bar. Search, Wisp creation,
and application settings use full-screen dialogs with their existing backend
actions and focus management. Wider windows keep the desktop panels.
The Electron window can be resized down to 360px wide to use this layout locally.

Returning to the list, opening settings, or resizing the window retains the
current conversation draft. On mobile, Enter inserts a newline; the send button
sends the message. The layout respects safe areas and follows the visual viewport
height when the software keyboard opens. It does not focus the composer merely
because a conversation was opened.

This implements the mobile **renderer layout**, using `template/mobile/` as its
visual reference. The app still requires the Electron bridge: opening the Vite
URL in a standalone mobile browser continues to show the bridge-required screen.
Remote access, web authentication, a PWA manifest, and offline support require a
separate web transport implementation; no desktop security checks are bypassed.

### Models per Wisp and first-time setup

**Settings → AI Model** manages the default model and encrypted, shared provider
keys. Providers with API-key authentication and models in Pi's installed catalog
are available. When creating a Wisp, the **Model** section can select another
provider/model and output-token limit for that Wisp, or keep **Use global model**
to inherit the default. Overrides are saved locally with the Wisp and restored on
restart; a Wisp's **Model** tab shows the selection read-only. An invalid override
requires configuration; it does not silently use a different provider. Removing
a provider key disables affected Wisps until the key is restored.

Idle Wisps switch immediately; active Wisps finish their current turn with the
previous model. The conversation header shows the actual model and any pending
change. Creating a Wisp without a provider is allowed, but sending is disabled
until configuration is complete. **Configure AI model** opens setup directly,
keeping the unsent draft intact.

### Plugins per Wisp

Open **Settings → Plugins**, enter a **Brave Search API key** or **Linear personal
API key**, optionally select **Test connection**, and select **Save plugin** with
the plugin enabled. Testing checks the entered key, or the saved key when the
field is blank; it does not save a new key. Each plugin supports one connection
on this device. Connecting a plugin grants no Wisp access automatically.

Open a Wisp's **Access** tab, choose **Read only** for web search or **Read only** /
**Read and write** for Linear, and select **Save access**. Every Wisp starts with
**No access**. New tools become available on its next message. Linear issue
creation and updates still require an **Allow once** approval before execution.

Web search returns titles, source URLs, and snippets through the
[Brave Search API](https://api-dashboard.search.brave.com/documentation/services/web-search);
it does not browse pages or fetch arbitrary URLs. Linear can search/read issues,
list teams and statuses, and create/update issues through its
[GraphQL API](https://linear.app/developers/graphql). The connected key's own
permissions also apply.

Disabling a plugin blocks all Wisps but retains their grants. Replacing a key
with a different key or removing its connection clears every Wisp's grants for
that plugin. Revocation blocks new calls and cancels pending approvals/requests;
it cannot undo a change already accepted by Linear. Check Linear before retrying
a write whose outcome is uncertain.

Firecrawl is available under **Web & research**, alongside Brave Search; Linear is
under **Productivity**. Connect a Firecrawl API key in Settings → Plugins, then
grant read access in a Wisp’s Access tab. The `firecrawl_scrape` tool reads one
HTTP(S) page as Markdown (long content is truncated) using the
[Firecrawl v2 scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape).
Scraping uses Firecrawl credits; Test connection checks credit usage without scraping.

This version includes these three bundled plugins. Arbitrary plugin
installation, custom endpoints, MCP servers, OAuth, and multiple accounts are
not available yet. See [ADR 004](docs/decisions/004-wisp-plugins.md) for the
extension boundary and validation scope.


### Context continuity

Open **Wisp settings → General → Context & memory** to configure context renewal.
By default, the next message after 24 hours of inactivity triggers a continuity
summary only when the active context is at least 12,000 tokens. Both values are
configurable. Optional daily renewal uses the computer's local time, is evaluated
on the next message, and also requires the minimum context size. Nothing runs
just because the clock passes the configured hour. Native Pi compression near
the model's context limit remains enabled even with manual renewal selected.

**Summarize context** retains decisions, goals, pending work, references and about
4,000 tokens of recent conversation using Pi's compaction boundaries. The exact
retained size depends on message boundaries. The summary is available in settings.
**Start new topic** explicitly clears the active conversation context while keeping
all messages on screen, the local transcript, Wisp identity, model and saved memory.
A timeline marker explains each boundary. The `search_history` tool can retrieve
bounded excerpts from this Wisp's earlier user/assistant messages when needed.

**Saved memory** is user-maintained text, stored locally and included in model
requests. It survives new topics and restarts; facts are not silently promoted
from summaries into permanent memory. Context controls require a configured Pi
session and cannot interrupt a response, queued message, or tool approval.
Summarization failure preserves the existing context and reports an error rather
than dropping history or sending the new message without continuity.

Usage totals include summarization input/output and cache tokens. Summary costs
use the runtime's persisted estimate when positive and available; unavailable
estimates remain unknown. The Usage tab identifies the summarization token subtotal.
