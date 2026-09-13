# Wisp Bot

Wisp Bot is an Electron desktop application for running persistent AI-agent
conversations. Each Wisp owns a persistent agent session on the Pi runtime,
with per-Wisp models, plugins, and approval-gated tools, while a sandboxed
Electron boundary owns credentials, sessions, and durable state.

<p align="center">
  <img src="docs/screenshot.png" alt="Wisp Bot app screenshot" width="800" />
</p>

The renderer uses React 19, TypeScript 7, Vite 8, Tailwind CSS 4, and locally
owned shadcn/ui components with the Base Nova preset.

## Highlights

- **Persistent agent conversations** — one durable Pi session per Wisp, with
  streaming events, retries, and compaction. See [AI models](docs/models.md).
- **Bundled plugins** — Brave Search, Linear, and Firecrawl, connected once and
  granted per Wisp. See [plugins](docs/plugins.md).
- **Remote MCP servers** — Streamable HTTP integrations with header or OAuth
  authentication, granted per Wisp. See [MCP servers](docs/mcp-servers.md).
- **Context and memory** — continuity summaries, explicit new topics, and
  user-maintained saved memory. See [context and memory](docs/context-and-memory.md).
- **Usage reports** — per-Wisp session reports and a local token/cost
  dashboard. See [token usage](docs/token-usage.md).
- **Approval-gated tools** — encrypted credential storage and per-Wisp tool
  authorization. See [security](docs/security.md).
- **Responsive layout** — a mobile-style single-screen layout below 760px.
  See [mobile layout](docs/mobile-layout.md).

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22.19 or later
- npm

Install dependencies and start the desktop development environment:

```bash
npm install
npm run dev
```

`npm run dev` starts Vite with React Fast Refresh and opens Electron. The Vite
URL alone is only a renderer preview; it deliberately cannot access the secure
desktop bridge.

For an explicit local fake-agent run that never contacts a provider, start
development with `WISP_AGENT_MODE=fake npm run dev`. Packaged builds ignore
this switch.

Development-only environment variables (all ignored by packaged builds unless
noted):

| Variable | Effect |
| --- | --- |
| `WISP_AGENT_MODE=fake` | Use the deterministic fake agent (unpackaged dev runs only). |
| `WISP_DATA_DIR` | Redirect the user-data directory for unpackaged runs (default `wisp-bot-dev`). |
| `VITE_FEATURE_CIRCLES=true` | Compile the experimental circles UI (no model sessions). |

### Quality gates

```bash
npm test
npm run lint
npm run format:check
npm run typecheck
npm run build
```

Use `npm run format` to apply the repository's Biome formatting rules.
`npm start` runs a production build and opens the locally built Electron
application.

Tests use fake agents and never contact a model provider. CI runs the test,
lint, formatting, typechecking, and build gates.

### Optional live Pi smoke

The opt-in smoke test makes one real provider request. It reads the key only
from the process environment, does not print model output or key material, and
removes its temporary session afterward.

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

Generated components are written to `src/components/ui/` and are maintained
locally.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Process boundary, project structure, runtime, data storage |
| [Security](docs/security.md) | Trust boundary, credential storage, tool authorization |
| [AI models](docs/models.md) | Global model settings and per-Wisp overrides |
| [Plugins](docs/plugins.md) | Brave Search, Linear, and Firecrawl connections and access |
| [MCP servers](docs/mcp-servers.md) | Remote MCP integrations, access, and revocation |
| [Context and memory](docs/context-and-memory.md) | Context renewal, summaries, new topics, saved memory |
| [Token usage](docs/token-usage.md) | Session reports and the usage dashboard |
| [Mobile layout](docs/mobile-layout.md) | Responsive single-screen layout below 760px |
| [Application settings](docs/application-settings.md) | App settings, notification sounds, updates, known limitations |
| [Installing on macOS](docs/installing-on-macos.md) | Running unsigned builds under Gatekeeper |
| [Release runbook](docs/release-runbook.md) | Staging, verification, and rollback for releases |
| [Decision records](docs/decisions/) | Architecture decision records (ADRs) |

## Desktop releases

Release targets, signing custody, staged channels, and rollback policy are
defined in [ADR 002](docs/decisions/002-distribution.md) and the
[release runbook](docs/release-runbook.md). `npm run dist:dir` creates an
unpacked local application for inspection; installers are produced only by the
protected `Desktop release` workflow, which creates drafts and never publishes
automatically.

Windows installers are signed through Azure Trusted Signing. macOS artifacts
are currently ad-hoc signed and not notarized, so first launch requires
removing the quarantine attribute — see
[installing on macOS](docs/installing-on-macos.md).

## Contributing

Run all quality gates before opening a change. Found a bug or have an idea?
[Open an issue](https://github.com/gustmrg/wisp-bot/issues).

## License

[MIT](LICENSE)
