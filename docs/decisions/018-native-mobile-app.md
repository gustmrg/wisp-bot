# ADR 018: A native mobile app with Wisps on the device

- Status: Proposed
- Date: 2026-10-11
- Decision owners: Wisp backend and renderer
- Scope: Running Wisps on a phone without a server, alongside connections to Wisp servers
- Related: [ADR 001](001-agent-runtime.md), [ADR 009](009-headless-server.md),
  [ADR 017](017-container-execution.md), [Wisp server](../remote-server.md)

## Context

On a phone, Wisp is the browser app served by a Wisp server and installed to
the home screen. The page is a thin client: every operation goes to that
server, and its service worker caches only the app's files. Using Wisp on a
phone therefore needs a server running somewhere and reachable from the
phone, usually over Tailscale.

The goal is a phone app that works like the desktop app: Wisps on **this
device**, with no server, plus optional connections to Wisp servers.

What was checked before deciding:

- **Embedding Node is not viable.** nodejs-mobile's latest release is Node
  18.20.4 (October 2024). The server needs Node 22.19 or later and uses
  `node:sqlite` (`backend/conversation-store.ts`, `backend/message-search.ts`).
- **The backend uses Pi's top layer.** It creates sessions through
  `@earendil-works/pi-coding-agent` (`AgentSession`, `SessionManager`,
  `ModelRuntime`), which reads and writes session files with `fs`, and runs
  processes with `child_process`. The layers below are nearly portable:
  `pi-agent-core` depends only on `pi-ai` and `typebox`, with no Node imports,
  and `pi-ai` uses Node only for its CLI, the OAuth callback server,
  environment keys and Bedrock. The provider SDKs it wraps run in browsers.
- **The rest of the backend** (about 18,600 lines) mostly needs files
  (`node:fs/promises` in 22 imports), `node:crypto` (16) and `node:path`, all
  of which have phone equivalents. `node:child_process` appears only in
  `container-cli.ts`.
- **T3 Code** ships native iOS and Android apps that are only clients: its
  agents are CLIs that cannot run on a phone, and its hosted relay makes the
  user's own machine reachable. It confirms the client half, not the local
  half.
- **A phone app without a server cannot keep Wisps working in the
  background on iOS**, which suspends apps shortly after they leave the
  screen. Android can keep working with a foreground service.

## Decision

**Build a Capacitor app around the existing renderer, with two kinds of
connection, and run the backend in the app for the local one.**

- **Shell:** Capacitor, so the React renderer is reused unchanged. React
  Native would need the interface rebuilt; Swift and Kotlin would need
  everything rebuilt, twice.
- **Connections:** the desktop's model. **This device** is the local
  environment; Wisp servers are added by pairing, as on the desktop.
- **Wisp servers:** reached over HTTPS on the tailnet (Tailscale Serve, as
  for the browser app) with bearer tokens, through `client/remote-session.ts`.
  Tokens are kept in the Keychain or Keystore through the existing
  `CredentialStore` interface. No SSH on the phone: the tailnet already
  encrypts the traffic, and installing servers stays a desktop task.
- **This device:** the backend runs in the app's JavaScript context and is
  called directly, without HTTP, the way the desktop reaches its server
  through IPC.
- **Platform ports in the backend:** file storage, the SQLite database,
  cryptography and key storage behind interfaces, with a Node implementation
  (server and desktop, behaviour unchanged) and a phone implementation
  (Capacitor Filesystem, a native SQLite plugin, WebCrypto, Keychain or
  Keystore).
- **The agent on the phone** is built on `pi-agent-core` and `pi-ai`, with
  its own session persistence, instead of `pi-coding-agent`.
- **Isolation:** the device is its own environment. Its Wisps, conversations
  and memory are not synced with the desktop or any server.

### What local Wisps can do

Several Wisps with souls, a model per Wisp with the user's keys, memory,
skills, remote MCP servers over HTTP, search plugins, attachments and a
workspace per Wisp in the app's sandbox.

They cannot run commands, since there are no containers on a phone
([ADR 017](017-container-execution.md)). On iOS a turn stops when the app
leaves the screen, and scheduled messages are sent only while it is open.

### Phases

1. **Spike:** in a Capacitor WebView on iOS, run one full turn with
   `pi-agent-core` and `pi-ai`, streaming, with one tool, against each
   provider in use. This settles the risks below before any refactor.
2. **Remote-only app:** the shell, the connection list, pairing by QR code
   (`wispctl pair` gains one) and bearer access to Wisp servers.
3. **Platform ports:** a refactor of the backend with no change in
   behaviour, covered by the existing tests.
4. **This device:** local Wisps with the reduced feature set.

## Consequences

- One codebase keeps serving desktop, server, browser and phone, but the
  backend gains a platform layer, and the phone's agent differs from the one
  on the desktop and server until all of them use the same Pi layer.
- **Protocol compatibility:** clients currently require the server's exact
  `REMOTE_PROTOCOL_VERSION`. A store app lags behind servers because of
  review, so before phase 2 ships, clients must accept a range of versions
  and rely on the server's list of operations.
- **Distribution** needs an Apple Developer account and the Play Store, or
  TestFlight and APK sideloading.
- **Push notifications** through APNs or FCM need the publisher's
  credentials, which a self-hosted server cannot hold without a Wisp Bot
  service. Web Push in the browser app does not, so notifications are out of
  scope here.

## Risks

- **CORS and streaming.** Calls to providers from the WebView are subject to
  CORS. Anthropic and OpenAI allow direct browser access with explicit flags;
  other providers may not. `CapacitorHttp` avoids CORS but does not stream
  responses, so a native streaming fetch plugin may be needed.
- **What only `pi-coding-agent` provides**, such as compaction and the
  session format, may have to be reimplemented for the phone.
- **Performance** of long sessions and message search in the WebView on iOS
  must be measured.

If the spike shows CORS or streaming cannot be solved in the WebView, the
fallback is React Native with `expo/fetch`, which streams and is not subject
to CORS, at the cost of rebuilding the interface.

## Alternatives considered

- **Embedded Node (nodejs-mobile):** blocked by its Node 18 runtime and an
  inactive project.
- **Expose the desktop's server to the phone:** the browser app already
  covers this, and it still needs a computer running.
- **Swift and Kotlin apps:** rebuild the backend, Pi's agent loop and the
  interface for each platform.
- **A native client only, like T3 Code:** keeps the need for a server, which
  is what this decision avoids.
