# ADR 001: Agent runtime and IPC boundary

- Status: Accepted
- Date: 2026-09-02
- Decision owners: Wisp product and security boundary
- Scope: the first real-agent conversation slice

## Provider and runtime

Wisp uses the pinned `@earendil-works/pi-coding-agent` runtime in the Electron main process. Pi supplies a provider/model catalog and persistent agent sessions while allowing Wisp to keep one provider-neutral contract. The first supported authentication mechanism is a provider API key selected in AI Model settings. OAuth is not exposed by this slice.

Each Wisp, but never a circle, owns one application-managed Pi session and workspace. The session streams lifecycle, text, retry, compaction, and tool events. Pi automatic retry is enabled with at most two retries. Provider rejection, transport failure, and rate limiting are returned as sanitized `conversation_error` events; retryability is data, not permission to resend automatically beyond the configured Pi retries.

A request may run for at most ten minutes. Reaching that deadline follows the same abort path as an explicit cancellation and produces a retryable sanitized error. The renderer also exposes Stop while work is active. Application shutdown and conversation deletion abort and settle active sessions before disposal.

## Trust boundaries and ownership

The renderer may request actions and render sanitized state. It never owns provider clients, API keys, session files, filesystem validation, cancellation primitives, retry policy, tool authorization, or audit decisions.

Electron main owns all privileged state and validates every request after checking that the sender is the main frame at the exact trusted renderer URL. The sandboxed preload exposes a frozen, explicit `WispApi`; arbitrary channel names and raw `ipcRenderer` are never exposed. Circles cannot be promoted into agent sessions.

## Credentials

Credentials are accepted only through the validated settings IPC request and are never returned to the renderer. The main process stores an encrypted credential map under Electron's user-data directory using `safeStorage`:

- macOS: Keychain-backed encryption;
- Windows: DPAPI-backed encryption for the current OS user;
- Linux: the desktop secret store selected by Electron (for example libsecret/KWallet).

If encryption is unavailable, or Linux reports Electron's `basic_text` fallback, credential persistence is refused with `secure_storage_unavailable`. Plaintext files, renderer storage, bundle environment values, command-line arguments, telemetry, and logs are prohibited credential locations.

## Request schemas and bridge API

`shared/contracts.ts` is canonical. Agent commands use these bridge methods and allowlisted channels:

- `startConversation({ conversationId })`
- `sendMessage({ conversationId, requestId, text })`
- `abortConversation({ conversationId })`
- `applyModel({ conversationId, model })`
- `disposeConversation({ conversationId })`
- `subscribeToAgentEvents(listener)`

Settings and durable conversation APIs are separate methods on the same typed bridge. Results are `BackendResult<T>` values; exceptions and SDK objects do not cross IPC.

Conversation and request IDs are 1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Prompts are nonblank and at most 32,000 UTF-16 code units. Provider/model IDs and credentials have their own validated limits. Unknown object keys are rejected where domain normalizers define closed records. File mutations are additionally limited to 1 MB of input and tool output to 64 KB.

## Event schemas and streaming order

Main-to-renderer traffic is the discriminated `ConversationAgentEvent` union in `shared/contracts.ts`. Events cover status, assistant start, bounded text deltas, completion, cancellation, safe errors, tool activity, retry/compaction notices, and approval lifecycle. Request-scoped events carry both `conversationId` and `requestId`; assistant events also carry `messageId`.

The registry adds one monotonically increasing process-local `sequence` to every event. For a request the normal order is assistant start, zero or more text deltas/tool events, then exactly one completed, cancelled, or error terminal outcome. The renderer ignores duplicate or older sequence numbers and overlays transient streamed messages on durable state. On reload it first reads durable state and the latest sequence, buffers concurrent events, then applies only newer events in order.

Text is bounded to 500,000 characters per response and emitted in chunks no larger than 8,000 characters. Tool payloads and provider-native event objects never cross the bridge.

## Cancellation and lifecycle

Abort is conversation-scoped and idempotent when the session is already idle. The main process marks the active request cancelled before invoking the provider abort, flushes pending translated output, and emits a cancelled terminal event. Deleting a Wisp removes it from the registry before disposal so late events cannot be published. Closing the app disposes all handlers and agents before the final quit.

Only one provider request runs per Wisp. Commands are serialized per Wisp, at most eight commands may be pending for one conversation, and at most four agents execute concurrently. A queued command rechecks deletion before execution.

## Errors

Expected failures use stable `BackendErrorCode` values and a safe message plus `retryable`. Unrecognized exceptions become `internal_error` and never expose stacks, provider bodies, paths, keys, or prompts. Configuration, unavailable models, invalid requests, deletion/disposal, cancellation, tool policy, approval expiry, and secure-storage failure remain distinguishable.

Provider authentication rejection and malformed provider responses are non-secret model failures. Network and rate-limit failures are retryable only when the adapter can establish that retry is safe; otherwise they use the conservative sanitized internal error. The UI retains the user's outgoing message and offers explicit retry where allowed.

## Retries and idempotency

`requestId` is the idempotency key within a conversation. Main keeps the most recent 1,024 accepted request IDs for each live session. Repeating a remembered ID must not issue a second provider prompt; while active it is treated as already accepted, and after completion it is rejected as `invalid_request`. Renderer retry creates a new request ID while relating the new attempt to the persisted outgoing message.

Only Pi's bounded two-attempt transport retry may automatically repeat provider work. IPC handlers acknowledge queue admission, not model completion. They do not impose an independent short IPC timeout; the ten-minute main-process execution deadline owns the long-running timeout.

## Observability and redaction

Structured logs may contain event name, timestamp, conversation ID, request ID, approval ID, safe error code, retryability, and lifecycle phase. Fields whose names or values resemble prompts, content, credentials, authorization, passwords, secrets, tokens, bearer values, or provider keys are redacted. Values are single-line and capped at 256 characters. Model input/output, tool file contents, full paths, SDK errors, and credentials must never be logged.

Audit hooks live in main process beside tool authorization. Renderer analytics or UI state are not authorization evidence.

## Acceptance tests

The implementation must cover:

1. send → accepted acknowledgement → ordered progress/text → persisted reply;
2. explicit cancel and ten-minute deadline, each with one terminal result;
3. provider rejection, network failure, and rate limit as sanitized classified errors;
4. app close aborting and disposing active work;
5. deleted conversations dropping queued commands and late events;
6. renderer reload reconciling durable state and sequence-buffered events;
7. duplicate request IDs never invoking the provider twice;
8. invalid sender, oversized prompt, malformed IDs, missing model, and unavailable secure storage;
9. credentials and prompt-shaped values absent from returned errors and logs.

Unit and integration tests use the fake agent/runtime. A live provider smoke is opt-in, reads credentials only from its process environment, prints no model content, and cleans its temporary session.

## Rejected alternatives

- Provider SDK in the renderer: rejected because it exposes credentials and privileged controls to web content.
- Direct `ipcRenderer` exposure or arbitrary channel proxy: rejected because it defeats the allowlist and schema boundary.
- Renderer-managed cancellation, retries, or authorization: rejected because reloads and compromised UI state could bypass policy.
- Plaintext credentials, bundled environment keys, or Linux `basic_text`: rejected because they do not provide acceptable at-rest secrecy.
- A provider-specific renderer schema: rejected because it couples UI state to SDK event and error shapes.
- One shared agent session for all Wisps: rejected because it mixes histories, cancellation, workspaces, and tool authority.
- Automatic replay after reload: rejected because a renderer cannot prove that provider work was not already accepted.

## Remote-instance extension (2026-09-07)

[ADR 004](004-remote-instance.md) extends this boundary with a headless server and remote clients. The privileged runtime now lives in `backend/` and is composed either by Electron main (local JSON/safeStorage) or the server (SQLite/external key). In remote mode, the server owns tools, provider credentials, execution, authorization and audit. Electron main owns only the paired device credentials and SSH/HTTPS transport; browser/native clients have explicit device sessions. Window IDs remain a local IPC sender check and are not network authorization.

The shutdown, process-local sequence and in-memory idempotency descriptions above continue to describe local mode. Remote client shutdown closes only its transport; durable request admission, event cursors and crash reconciliation are implemented server-side. Approvals use the instance owner plus the authenticated deciding device and persist atomically. A server restart interrupts uncertain running requests rather than resubmitting their effects. Neither `disposeConversation` nor renderer legacy initialization is exposed as a remote ownership operation.
