# Wisp Bot

Wisp Bot is an Electron desktop application for running persistent AI-agent conversations. Its React renderer manages the workspace UI while a sandboxed Electron boundary owns conversations, model credentials, agent sessions, file-tool authorization, and durable backend state.

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
- `electron/backend/` owns durable conversations, model configuration, Pi sessions, the fake test gateway, encrypted credentials, and tool authorization. `electron/ipc/` validates and registers the narrow bridge handlers.
- `electron/security-policy.ts`, `electron/main.ts`, and `electron/preload.ts` enforce the renderer trust boundary: sandboxing and context isolation stay enabled, navigation and permissions default to deny, and exposed APIs are typed and sender-checked.

## Current behavior

Wisp conversations are connected to persistent application-managed Pi sessions when a model and encrypted API key are configured. Read-only workspace tools are available; file creation and modification pass through main-process policy and user approval. The fake agent implementation remains as a deterministic test adapter, not the production renderer transport.

Conversations and backend policy are stored under Electron's user-data directory. Theme, timezone, microphone selection, launch-at-login, notification-sound, and related UI preferences are stored locally in the renderer. Theme and auto-review policy affect current behavior; microphone capture, launch-at-login, notification sounds, sign-out, and shortcuts are not connected yet. Installed releases expose explicit check, download, and restart-to-install update states in About. Circles are feature-flagged and do not run their own model sessions.

API keys are encrypted with Electron's operating-system-backed `safeStorage` API and are never exposed to the renderer. Wisp refuses to persist keys when secure storage is unavailable. Unknown file actions are blocked; conflicting auto-review rules use `block` → `ask` → `allow` precedence.

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

Open a Wisp's settings and expand **Session activity** to inspect its current Pi
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
