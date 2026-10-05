# ADR 009: Headless Wisp server

- Status: Accepted
- Date: 2026-10-05
- Decision owners: Wisp runtime and security boundary
- Scope: Running the Wisp backend as a persistent process that clients reach over the network
- Related: [Headless server](../remote-server.md), [architecture](../architecture.md), [security](../security.md)

## Context

The backend lives in `backend/` and never imports Electron; `backend/runtime.ts`
composes it from host capabilities. A long-lived server lets Wisps keep working
while no client is open and lets several devices share one set of
conversations. An earlier prototype (pull request #10) kept a separate
conversation store and a REST route per operation; it fell far behind the
desktop as features were added.

## Decision

**Same runtime, same handlers.** The server composes `createBackendRuntime`
like the desktop and registers the same operation handlers
(`backend/handlers/register-runtime-handlers.ts`). Conversations stay in the
backend's own SQLite store, with the desktop's layout. A feature added to the
backend reaches both hosts without server-specific code.

**RPC that mirrors the bridge.** `POST /api/v1/rpc/<operation>` accepts the
`WispApi` operation's request and returns its `BackendResult`. Push channels
share one server-sent event stream. A remote client can implement `WispApi`
generically instead of mapping 50 operations to routes. Desktop-only
operations (updates, launch at login) are not registered on the server, and
host actions that need a local screen fail with `unsupported`.

**Devices, not passwords.** A device pairs with a one-time code from
`wispctl pair`, which only the account owning the data directory can run
(through an owner-only Unix socket). Access tokens are random, last 15
minutes, and live only in memory; refresh tokens are stored as hashes and
rotate on every use, with a one-minute grace for lost responses. Every device
acts for the single owner, so tool approvals are shared between devices. SSH or
Tailscale provide reachability; neither replaces pairing.

**Events without a durable log.** Events carry `<bootId>:<sequence>` ids and
the latest 5,000 stay in memory for replay. A client with an unknown or
too-old cursor gets `resync` and reloads state, which the backend persists in
full. The server publishes events as they happen, in one order, so a client
never sees one event after a later one.

**Encrypted credentials without a desktop keychain.** Credentials are encrypted
with AES-256-GCM under a 32-byte key file outside the data directory. The
envelope names its key, so key rotation can be added later.

**Loopback by default.** The server listens on 127.0.0.1 and checks the Host
header and the Origin header. Exposure goes through SSH tunnels or a private
HTTPS proxy. A SQLite exclusive lock guarantees one server per data directory
without relying on PIDs.

## Consequences

- Requests after a crash are not replayed: an interrupted reply is lost, as on
  the desktop, and a retried request ID is rejected rather than run twice.
- Restarting the server makes every client refresh its access token once and
  resync its event stream.
- MCP OAuth sign-in, opening folders, and attaching files need a client-side
  flow before they work remotely.
- Web and mobile clients will need cookie sessions or allowed origins; the
  server answers no browser origins yet.
