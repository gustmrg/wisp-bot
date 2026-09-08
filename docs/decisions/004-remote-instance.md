# ADR: persistent single-owner remote instances

Status: accepted for this implementation, 2026-09-07.

The Electron runtime previously owned agents and JSON persistence. A remote client must be able to disconnect without stopping work, and two clients must see the same history. A transport change alone does not provide durable admission or shared authorization.

The common backend now composes platform adapters. Local desktop retains JSON and Electron safeStorage; the Linux server uses Node 24 node:sqlite with WAL, full synchronous commits, an exclusive process lock and an external AES key. The server runtime package excludes Electron. HTTP commands and fetch-based SSE have explicit versioned schemas. Admission stores request identity, outgoing message and outbox before ACK; completion events persist before publication. Server crash recovery interrupts uncertain running work instead of replaying side effects.

Instance ownership uses a separate `instance-lock.sqlite` connection holding `BEGIN EXCLUSIVE` in rollback-journal mode for the process lifetime. The OS releases this lock after a crash; ownership does not depend on PIDs, which containers may reuse. The guard database and diagnostic `server.lock` are excluded from backups and migrations. This follows SQLite's [exclusive transaction](https://www.sqlite.org/lang_transaction.html) and [file locking](https://www.sqlite.org/lockingv3.html) semantics. Use a local filesystem with working file locks, and never delete a live instance's guard file.

SSH is a protected network tunnel and administrative pairing channel. It is not the conversation identity. The server has a persistent identity, owner principal, revocable devices and durable request IDs. Tailscale supplies private reachability, optional SSH identity checks and Serve HTTPS; application pairing remains mandatory. Browser sessions use same-origin HttpOnly cookies plus CSRF. Native mobile and Electron use device bearer tokens outside renderer/browser storage. Closing a client only disposes the client transport.

The frontend consumes an injected BackendApi; desktop updates and connection controls remain separate APIs. Mobile uses Capacitor with platform secret storage and HTTPS. Offline drafts do not imply automatic message replay. A restore revokes old devices and changes the event generation to avoid reviving historical sessions.

The chosen Node 24 SQLite API is experimental in that Node line, so runtime builds/tests pin Node 24.18.0. The implementation targets a single owner and one executor process, not tenant isolation or clustered availability. Archive limits deliberately bound memory and path handling. Linux x64/arm64, native builds and live network behavior have separate evidence entries; compilation alone is not evidence of a live tailnet connection.

The main baseline (0271ca1) does not contain the plugin subsystem that existed in a different worktree when the plan was written. Plugin migration/routes are therefore inapplicable to this branch; the unrelated plugin branch is not imported. Backend adapter boundaries are ready for that subsystem when it merges.
