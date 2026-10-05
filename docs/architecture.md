# Architecture

Wisp Bot is an Electron desktop application for running persistent AI-agent
conversations. Its React renderer manages the workspace UI while a sandboxed
Electron boundary owns conversations, model and plugin credentials, agent
sessions, tool authorization, and durable backend state.

## Process boundary

The renderer may request actions and render sanitized state. It never owns
provider clients, API keys, session files, filesystem validation, cancellation
primitives, retry policy, tool authorization, or audit decisions — the
Electron main process owns all privileged state and validates every request
after checking that the sender is the main frame at the exact trusted renderer
URL.

- `src/components/` contains renderer presentation. `src/App.tsx` only composes
  the primary panels and dialogs.
- `src/features/workspace/` owns the renderer workspace controller and
  integrity-preserving actions. `src/hooks/use-conversations.ts` adapts the
  typed desktop bridge into React state and streamed events.
- `src/features/persistence/` validates and persists local UI preferences with
  observable failure handling.
- `shared/` defines process-safe conversation, tool-policy, and IPC contracts
  (`shared/contracts.ts` is canonical). Results cross the boundary as
  `BackendResult<T>` values; exceptions and SDK objects do not.
- `backend/` owns durable conversations, model configuration, Pi sessions,
  plugin and MCP connections with per-Wisp grants, the fake test gateway,
  encrypted credentials, tool authorization, and request validation. It never
  imports Electron: `backend/runtime.ts` composes the services from injected
  host capabilities (encryption, folder and file pickers, event sinks), so any
  host can run the same backend. `electron/backend/` keeps only desktop
  concerns: `safeStorage` encryption, updates, and launch at login.
- `backend/handlers/` registers the operations a client can call; every
  handler goes through `guarded-handlers.ts`, which checks the sender and
  returns sanitized `BackendResult`s. `electron/create-backend.ts` composes the
  runtime with Electron capabilities and registers those handlers, plus the
  desktop-only ones in `electron/ipc/`, on `ipcMain`, so the whole backend can
  be built and tested without Electron.
- `electron/connections/` decides where the backend runs. The main process
  routes every runtime operation to the local runtime, started only while
  **This computer** is chosen, or to a Wisp server through `client/`'s
  reconnecting session over an SSH tunnel or HTTPS. The renderer's
  `ConnectionGate` remounts the app whenever the backend changes.
- `server/` runs the same runtime and handlers as a headless process behind
  authenticated HTTP and server-sent events. See
  [headless server](remote-server.md) and
  [ADR 009](decisions/009-headless-server.md).
- The main process is the only writer of agent-driven conversation state (reply
  text, outgoing delivery status, context notices). After persisting a change it
  pushes what changed on `wisp:conversations:changed`: the conversation's
  summary and the messages it added or updated. The renderer writes only what
  the user authored and never re-fetches the full state to reconcile.
- The renderer holds a summary of every conversation and the messages of only
  the five it opened most recently. It reads a transcript a page at a time,
  newest first, and loads older pages as the user scrolls up. Message search
  runs in the backend; opening a result loads the page around that message.
- `electron/security-policy.ts`, `electron/main.ts`, and `electron/preload.ts`
  enforce the renderer trust boundary: sandboxing and context isolation stay
  enabled, navigation and permissions default to deny, and the sandboxed
  preload exposes a frozen, explicitly typed `WispApi` — never arbitrary
  channels or raw `ipcRenderer`.

See [security](security.md) for credentials, authorization, and the full trust
boundary; [ADR 001](decisions/001-agent-runtime.md) defines the runtime and IPC
boundary in depth.

## Runtime

Each Wisp (never a circle) owns one persistent, application-managed Pi session.
Applying a model validates it immediately, but the session itself (which loads
the Wisp's full history) opens on first use — a message or a context request —
so startup time does not grow with every Wisp's transcript. Requests stream
lifecycle, text, retry, compaction, and tool events; Pi automatic retry is
capped at two retries, and a request may run for at most ten minutes before it
is aborted with a retryable sanitized error. On quit, agents get five seconds to
settle before the app exits anyway.

The bundled fake agent is a deterministic test adapter used by tests and
opt-in development runs (`WISP_AGENT_MODE=fake`, unpackaged builds only); it is
not the production transport.

## Project structure

```text
wisp-bot/
├── .github/workflows/
│   ├── ci.yml                     # Repository quality gates
│   └── release.yml                # Version bump, packaging, and GitHub release
├── build/                         # Packaging icons
├── docs/                          # Guides and decision records
├── backend/                       # Persistence, services, agents, and authorization
│   ├── handlers/                  # Operation handlers shared by IPC and HTTP
│   └── runtime.ts                 # Host-independent backend composition and shutdown
├── client/                        # Remote client: protocol, events, reconnecting session
├── deploy/                        # systemd, Docker, and wispctl for the server
├── electron/
│   ├── backend/                   # Desktop-only services (safeStorage, updates, login)
│   ├── connections/               # Connection profiles, SSH tunnels, backend routing
│   ├── ipc/                       # Desktop-only IPC handlers (updates, launch at login)
│   ├── create-backend.ts          # Runtime exposed over IPC, with shutdown
│   ├── main.ts                    # Window lifecycle and trust-boundary wiring
│   ├── preload.ts                 # Sandboxed typed renderer bridge
│   └── security-policy.ts         # Pure URL, permission, and CSP policy
├── server/                        # Headless server: HTTP API, pairing, admin CLI
├── shared/                        # Cross-process contracts and domain types
├── src/
│   ├── components/                # Renderer feature and UI components
│   ├── config/                    # Application metadata
│   ├── features/persistence/      # Validated local preference persistence
│   ├── features/workspace/        # Workspace controller and domain actions
│   ├── hooks/                     # Conversation and interaction adapters
│   ├── lib/                       # Renderer policies and pure helpers
│   ├── App.tsx                    # Top-level renderer composition
│   └── main.tsx                   # Renderer entry point and bridge guard
├── scripts/                       # Release checksums and live Pi smoke
├── tests/                         # Backend, Electron, and contract tests
├── index.html                     # Renderer HTML and generated CSP slot
└── vite.config.mts                # Renderer build and development policy
```

## Data storage

Conversations, Pi session files, usage history, and backend policy are stored
under Electron's user-data directory, including versioned integration state
(`plugins.json`, `mcp-servers.json`) and separately encrypted credential
stores for model keys, plugin keys, and MCP secrets. Unpackaged dev runs
redirect that directory to `wisp-bot-dev` (override with the `WISP_DATA_DIR`
environment variable) so testing never touches the installed app's data.

Conversations live in `backend/conversations.sqlite` (Node's built-in
`node:sqlite`, write-ahead logging), with one row per conversation and one per
message, so a change writes only its own rows. The main process keeps the
stores in memory as its read model and adopts a change only after its
transaction commits. Each conversation keeps its newest 10,000 messages; older
ones leave the displayed transcript, while the Wisp's Pi session keeps its own
full history. On first run the legacy `conversations.json` store is imported
once and kept beside the database as `conversations.json.migrated-<time>`. A
database that cannot be read, or that a newer app version wrote, is set aside
as `conversations.sqlite.corrupt-<time>` and a fresh store starts.
A trigram full-text index over message text (kept in sync by triggers) serves
message search from a worker thread with its own read-only connection, and
transcripts can be read a page at a time; each conversation also records its
`lastActivityAt`. The store records the layout that wrote it and the oldest
layout that can still read it, so additive changes stay readable by older
builds. [ADR 006](decisions/006-paged-conversation-transcripts.md) describes the
move to loading transcripts on demand. The renderer already reads pages and
searches through the backend; the main process still loads every transcript at
startup and sends them with the full conversation state until the last step.

Theme, timezone, microphone selection, launch-at-login, notification-sound,
and related UI preferences are stored locally in the renderer through the
validated persistence layer. See
[application settings](application-settings.md) for what each setting does
today.
