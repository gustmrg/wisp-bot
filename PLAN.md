# Wisp Bot Backend Implementation Plan

## Objective

Replace the current simulated replies and renderer-only `localStorage` state with a real Electron backend in which each Wisp conversation owns one persistent Pi coding-agent session. A single provider, model, and provider API key configured in application settings will be used by every live Pi session.

This plan is intentionally split into reviewable phases. Only one phase should be implemented and reviewed at a time, and no phase should be committed without explicit approval.

## Current baseline

- `src/App.tsx` owns all chat state, persists it to `localStorage`, and generates fake replies with timers.
- `electron/main.ts` only creates the window. There is no preload script, IPC contract, backend state store, or agent lifecycle manager.
- Provider, model, and credential settings do not exist yet.
- Circles are feature-flagged off. The first backend slice will target Wisp conversations; circle orchestration remains out of scope until its semantics are defined.
- There is no automated test runner beyond TypeScript checks and the production build.

## Architecture decisions

### Embed Pi in the Electron main process

Use the `@mariozechner/pi-coding-agent` SDK directly instead of spawning the CLI in RPC mode. Pi documents the SDK as the preferred option for a type-safe integration in the same Node.js process, and its `AgentSession` exposes streaming, tool, message, and lifecycle events needed by the UI.

The renderer must not import Pi or Node/Electron APIs. A context-isolated preload script will expose a narrow, typed `window.wisp` API backed by validated IPC handlers.

### Put an application-owned interface in front of Pi

Application code will depend on a backend interface rather than directly on Pi types. The initial contract should resemble:

```ts
interface ConversationAgent {
  start(): Promise<void>;
  send(request: SendMessageRequest): Promise<void>;
  abort(): Promise<void>;
  applyModel(config: ModelSelection): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: ConversationAgentEvent) => void): () => void;
}
```

`PiConversationAgent` will implement this contract. A fake implementation will support deterministic renderer and lifecycle tests. Shared DTOs must use Wisp-owned types rather than leaking Pi SDK objects over IPC.

### One persistent session per Wisp conversation

An `AgentRegistry` in the main process will hold one live `ConversationAgent` per Wisp conversation while the app is running. Each registry entry will have:

- a stable Wisp/conversation ID;
- an application-owned working directory under Electron's `userData` directory;
- an application-owned Pi configuration directory;
- a persistent Pi JSONL session file/directory;
- one active request at a time, with later user messages queued in order;
- an event subscription that is removed during disposal.

Existing sessions will be restored when the backend starts. Creating or deleting a Wisp will create or dispose the matching registry entry. App shutdown will abort active work, unsubscribe listeners, dispose all sessions, and flush state. Session creation itself must not call the model.

### Keep global model selection separate from secrets

The selected `providerId` and `modelId` are normal backend settings. API keys are secrets and must never be stored in `localStorage`, renderer preferences, logs, error payloads, or Pi's plaintext `auth.json`.

Use Electron `safeStorage` to encrypt an app-owned credential file under `userData`. Decrypt only in the main process and inject the selected provider's key into Pi as a runtime credential. The renderer may receive only credential metadata such as `{ providerId, configured: true }`. If secure OS storage is unavailable, key persistence must fail with an actionable message rather than silently writing plaintext.

Credentials may be stored by provider so changing models does not require re-entering the key. Only the globally selected provider/model is active, and it is applied to all sessions. A model change during an active turn takes effect after that turn finishes; idle sessions update immediately.

### Separate canonical agent history from UI projections

Pi's persisted session is the canonical LLM context. The Wisp backend store remains the canonical source for Wisp metadata and renderer-oriented message records. Each message receives a stable ID and status (`queued`, `streaming`, `complete`, `failed`, or `cancelled`) so streamed deltas can update one record idempotently.

Pi events will be translated into Wisp events:

- text deltas -> an assistant message projection;
- agent start/end -> conversation working/idle status;
- tool start/update/end -> tool activity records;
- retry/compaction -> non-message status events;
- failures -> structured, sanitized errors.

Thinking/reasoning content will not be sent to the renderer. Raw tool payloads must be filtered before crossing IPC.

### Start with a safe tool boundary

The first real conversation slice will expose only read-only workspace tools (`read`, `grep`, `find`, and `ls`). Shell, write, and edit tools must remain disabled until the existing auto-review settings have a backend enforcement layer and the renderer can answer approval requests. Tool authorization must occur in the main process; UI checks alone are not security controls.

## Target backend layout

Names may be adjusted to match implementation details, but responsibilities should remain separated:

```text
electron/
  main.ts
  preload.ts
  ipc/
    register-handlers.ts
    validators.ts
  backend/
    backend-service.ts
    app-state-store.ts
    credential-store.ts
    model-service.ts
    agent-registry.ts
    conversation-agent.ts
    pi-conversation-agent.ts
    event-translator.ts
shared/
  contracts.ts
  models.ts
src/
  lib/wisp-api.ts
  hooks/use-conversations.ts
  components/model-settings-section.tsx
```

Backend data should live below `app.getPath("userData")`, with schema-versioned JSON metadata written atomically and separate directories for credentials, Wisp workspaces, and Pi sessions. Paths and secrets must not be returned to the renderer.

## Phase 1 — Establish the secure backend boundary

**Goal**

Create the typed Electron boundary and Wisp-owned agent abstraction without changing the current visible mock behavior.

**Scope**

- Electron preload/build configuration.
- Shared request, response, error, and event contracts.
- IPC registration and runtime payload validation.
- `ConversationAgent` interface plus a fake implementation.
- A small automated test setup.

**Implementation steps**

1. Add `electron/preload.ts`, configure `BrowserWindow` with the compiled preload path, and keep `contextIsolation: true`, `nodeIntegration: false`, and sandbox-compatible APIs.
2. Add shared serializable DTOs for model settings, conversation commands, message records, lifecycle state, and sanitized errors.
3. Expose a minimal `window.wisp` facade using `contextBridge`; do not expose raw `ipcRenderer` or generic channel invocation.
4. Add allowlisted IPC handlers with runtime validation for IDs, text length, and enum values.
5. Define `ConversationAgent`, `ConversationAgentFactory`, and event contracts independent of Pi.
6. Implement a deterministic fake agent and unit tests for subscription, send, abort, ordering, disposal, and error behavior.
7. Add a test command (prefer Vitest for the existing Vite/TypeScript stack) and document it in `README.md`.

**Validation**

- `npm run test`
- `npm run typecheck`
- `npm run build`
- Manual Electron smoke check confirming the app loads with the preload enabled and no Node globals are exposed to the renderer.

**Exit criteria**

- The renderer can call a narrow typed API and receive fake agent events.
- Invalid IPC payloads are rejected with sanitized errors.
- No Pi package or secret has entered renderer code.
- Existing UI behavior still works.

**Suggested commit message**

`feat(backend): establish typed Electron agent boundary`

## Phase 2 — Add global model settings and secure credentials

**Goal**

Let the user configure one global provider/model pair and securely add, replace, or remove the provider API key.

**Scope**

- Pi SDK dependency and model catalog access in the main process.
- Backend configuration and credential stores.
- A functional AI/model section in the existing settings dialog.
- Credential and settings IPC.

**Implementation steps**

1. Pin a compatible `@mariozechner/pi-coding-agent` version and record the chosen SDK surface; avoid semver drift while the integration is developed.
2. Build a `ModelService` around Pi's model runtime/registry that returns normalized provider and model summaries, not SDK types.
3. Implement a schema-versioned settings store for the active `providerId` and `modelId`, using atomic replacement writes.
4. Implement the `safeStorage` credential store and inject decrypted values through Pi's runtime-key API. Redact known keys from all backend errors and logs.
5. Add IPC operations to list providers/models, read the current selection, save the selection and key, remove a key, and report whether a provider is configured.
6. Add an “AI Model” settings section with provider and model selectors, a masked key field, configured/not-configured state, save/replace/remove actions, loading states, and inline errors.
7. Validate provider/model compatibility locally. Make any remote “test key” operation explicit because it may incur a provider request and cost; do not send a hidden test prompt on every save.
8. Ensure changing providers requires a key for the new provider before it becomes active.

**Validation**

- Unit tests for configuration normalization, atomic persistence, encryption/decryption, unavailable secure storage, redaction, and invalid provider/model combinations.
- IPC tests proving that no response or event contains key material.
- `npm run test`
- `npm run typecheck`
- `npm run build`
- Manual save/relaunch/replace/remove credential checks on the development OS.

**Exit criteria**

- A provider and model can be selected from Pi's catalog and survive restart.
- A configured API key survives restart only as encrypted application data and is never readable by renderer code.
- Missing, invalid, and unavailable-credential states are clear in the settings UI.
- No agent session is started yet.

**Suggested commit message**

`feat(settings): configure Pi provider model and credentials`

## Phase 3 — Move conversations behind the backend and manage session lifecycle

**Goal**

Make the main process the owner of Wisp/conversation records and establish exactly one managed agent instance for each Wisp conversation.

**Scope**

- Backend Wisp/conversation repository.
- One-time migration from the current `localStorage` state.
- `AgentRegistry` lifecycle and per-Wisp filesystem layout.
- Renderer state hook/store backed by `window.wisp`.

**Implementation steps**

1. Add schema-versioned backend records for Wisp metadata, conversation metadata, stable message IDs/status, session identity, and timestamps.
2. Implement atomic backend persistence and corruption recovery that preserves the bad file for diagnosis instead of silently overwriting it.
3. Add a one-time renderer-to-main migration: read the current `wisp-bot-ui-v3` payload, validate/import it, receive an acknowledgement, and only then remove the legacy key. Make import idempotent.
4. Create an app-owned workspace and Pi session location for every non-circle Wisp. Do not use the Wisp Bot source repository or an arbitrary process CWD as an agent workspace.
5. Implement `AgentRegistry` with create/get/list/delete/dispose operations, a per-conversation FIFO command queue, and cross-conversation independence.
6. Start/restore all Wisp registry entries after configuration and state stores are ready. A missing global model configuration should leave entries in `configuration_required`, not crash startup.
7. Route Wisp create/update/delete and transcript reads through IPC, and replace direct `localStorage` mutation in `App.tsx` with a renderer hook/client.
8. Dispose and delete session/workspace data only as part of an explicit Wisp deletion flow; define whether deletion is recoverable before implementing permanent removal.

**Validation**

- Unit tests for atomic state writes, corrupt state recovery, migration idempotency, and registry create/delete/dispose behavior.
- Integration tests using the fake agent to prove one instance per Wisp, FIFO ordering within a Wisp, and parallel independence across Wisps.
- `npm run test`
- `npm run typecheck`
- `npm run build`
- Manual restart test confirming Wisps and transcripts restore without duplication.

**Exit criteria**

- The main process, not `localStorage`, owns Wisp and conversation data.
- Every Wisp has exactly one live registry entry and stable persisted session identity.
- Startup, shutdown, create, and delete lifecycle paths dispose resources correctly.
- The UI still uses the fake agent, isolating persistence/lifecycle risk from Pi integration risk.

**Suggested commit message**

`feat(backend): persist Wisps and manage agent lifecycle`

## Phase 4 — Implement the Pi conversation adapter

**Goal**

Replace the fake backend agent with a persistent Pi `AgentSession` for each Wisp and prove the adapter independently of the UI.

**Scope**

- `PiConversationAgent` and factory.
- Persistent Pi sessions and app-owned resource configuration.
- Global model/key propagation.
- Pi-to-Wisp event translation.

**Implementation steps**

1. Create one shared Pi model runtime for catalog/credentials and one `AgentSession` per registry entry.
2. Resolve the configured provider/model explicitly and fail with `configuration_required` or `model_unavailable` rather than allowing Pi to choose a fallback silently.
3. Create/restore each Pi session using its Wisp workspace and persistent session manager. Store the concrete session path/ID in backend metadata after creation.
4. Supply an app-owned system prompt derived from the Wisp's name, label, and description. Disable project-local Pi extensions/skills until a trust model is implemented.
5. Initially allow only read-only workspace tools. Keep bash/edit/write unavailable in this phase.
6. Subscribe to Pi events and translate text, agent lifecycle, tool lifecycle, retry, compaction, completion, abort, and error states into Wisp-owned events.
7. Accumulate streamed text under a stable assistant message ID and throttle/coalesce downstream delta events so IPC and disk writes are not performed per token.
8. Apply global model changes to all idle sessions and stage them for active sessions. Apply a replaced API key through the shared runtime without persisting it in Pi's plaintext auth file.
9. On app shutdown or Wisp deletion, abort active prompts, unsubscribe, and call `dispose()` exactly once.

**Validation**

- Adapter tests with mocked Pi events for delta ordering, finalization, tool-event filtering, aborts, retries, errors, model switching, and disposal.
- Lifecycle integration tests proving separate Wisp histories cannot leak into one another.
- A manually invoked, environment-gated smoke test against one real provider/model; it must not run in normal CI or expose/capture the key.
- `npm run test`
- `npm run typecheck`
- `npm run build`

**Exit criteria**

- Each Wisp registry entry owns one real persistent Pi session.
- Prompts complete through Pi with isolated histories and the configured global provider/model.
- Restart resumes the matching Pi history.
- Only sanitized Wisp events leave the main process.

**Suggested commit message**

`feat(agent): integrate persistent Pi conversation sessions`

## Phase 5 — Wire real streaming conversations into the UI

**Goal**

Replace fake timers with end-to-end sending, streaming, cancellation, and error recovery through the backend.

**Scope**

- Renderer conversation client/hook.
- `App.tsx`, `ChatPanel`, and message rendering.
- Streaming status, queueing, abort, and errors.
- Removal of simulated replies.

**Implementation steps**

1. On submit, create a client request/message ID and call the backend. Disable duplicate submission while the acknowledgement is pending.
2. Reconcile acknowledgements and streamed events by stable IDs so retries, remounts, or replayed events cannot duplicate messages.
3. Render one assistant message while it streams, then mark it complete on agent end. Preserve the existing working indicator using backend lifecycle state.
4. Show queued state for messages submitted while the same Wisp is working. Different Wisp conversations must remain independently usable.
5. Add a stop action that calls `abort`, marks the current assistant message cancelled, and leaves the session usable for the next prompt.
6. Surface actionable settings/auth/rate-limit/network/model errors without exposing raw provider payloads or secrets. Provide retry only where the command is safe to repeat.
7. Remove reply timers, timer cleanup, and other mock-response paths from `App.tsx`.
8. Reconcile initial renderer state from a backend snapshot plus a monotonic event sequence number to close the subscribe-versus-load race.

**Validation**

- Renderer tests for submit acknowledgement, streaming deltas, event replay, queueing, switching chats during a stream, cancellation, error/retry, and unsubscription.
- End-to-end Electron test with the fake adapter for deterministic multi-conversation behavior.
- Manual real-provider checks: first prompt, follow-up context, simultaneous prompts in two Wisps, cancellation, model change, app restart, and recovery from an invalid key.
- `npm run test`
- `npm run typecheck`
- `npm run build`

**Exit criteria**

- There are no simulated assistant replies.
- Real Pi output streams into the correct Wisp without duplication or cross-conversation leakage.
- Working, queued, stopped, failed, and completed states are represented accurately.
- The app remains usable after aborts and recoverable provider errors.

**Suggested commit message**

`feat(chat): stream Pi responses into Wisp conversations`

## Phase 6 — Enforce tool approvals and harden the backend

**Goal**

Allow Pi coding actions without giving a model unrestricted filesystem or shell authority, then verify production lifecycle and failure behavior.

**Scope**

- Main-process tool authorization broker.
- Existing auto-review settings/rules.
- Approval request UI and tool activity display.
- Security, load, recovery, and packaging checks.

**Implementation steps**

1. Define stable tool/action categories and compile `allow`/`ask`/`block` rules in the main process. Default unknown or malformed actions to `ask` or `block`.
2. Wrap or replace Pi tools so authorization occurs before execution. Never rely on renderer-side checks.
3. Constrain file operations to the Wisp workspace using canonical-path checks that handle traversal and symlinks. Treat shell commands as separately privileged because a workspace CWD is not a sandbox.
4. Translate an `ask` decision into an expiring approval request bound to conversation ID, tool-call ID, and exact action summary. Reject stale, duplicate, cross-window, and mismatched responses.
5. Connect the existing auto-review preferences to persisted backend policy and add the renderer flow for approve once, deny, and block.
6. Enable edit/write tools after their checks pass. Keep shell disabled unless an explicit shell policy or OS sandbox is implemented and reviewed.
7. Render sanitized tool activity and outcomes in the transcript without exposing hidden prompts, secrets, or unbounded output.
8. Add limits for prompt size, pending queue depth, event payload size, tool output, and simultaneous active agents. Add structured secret-redacted logging.
9. Test crash/restart during streaming, network loss, provider throttling, corrupt state, session restore failure, credential loss, Wisp deletion during work, window reload, and clean app shutdown.
10. Verify packaged builds can load the Pi SDK, preload script, and required runtime assets on each supported OS.

**Validation**

- Unit and integration tests for rule precedence, default deny/ask behavior, path traversal, symlink escape, approval binding/expiry, shell blocking, payload limits, and secret redaction.
- Multi-Wisp load test with deterministic fake agents.
- Electron security checklist and packaged-app smoke test.
- `npm run test`
- `npm run typecheck`
- `npm run build`

**Exit criteria**

- No mutating tool runs without a main-process policy decision.
- Approval requests cannot be replayed or applied to another Wisp/tool call.
- File operations cannot escape the configured workspace.
- Failure and restart scenarios preserve usable, internally consistent conversations.
- The packaged application starts and runs Pi successfully on supported platforms.

**Suggested commit message**

`feat(agent): enforce tool approvals and harden Pi runtime`

## Cross-phase invariants

- Never send API keys, decrypted credentials, raw Pi objects, hidden reasoning, or unsanitized tool output to the renderer.
- Never log prompts or credentials by default.
- Validate every renderer-to-main payload at runtime even when TypeScript types exist.
- Keep one in-flight Pi turn per Wisp; serialize same-Wisp messages and allow different Wisps to work independently.
- Use stable IDs and idempotent handlers for messages, migration, events, and deletion.
- Dispose subscriptions, sessions, and IPC listeners on every lifecycle path.
- Do not silently fall back to a different provider or model.
- Do not enable project-local extensions, arbitrary skills, mutating tools, or shell execution before their trust/approval boundary is reviewed.
- Preserve unrelated existing working-tree changes during every phase.

## Deferred decisions and follow-ups

- Circle conversations: decide whether a circle owns its own Pi session, routes to member sessions, or acts only as an aggregate before enabling the feature.
- User-selected workspaces/repositories: the initial app-owned workspace keeps the backend deterministic; selecting external directories needs explicit trust, persistence, and permission UX.
- Multiple windows/devices and remote always-on workers: the initial registry is local and process-bound. Moving Wisps to remote computers will require a transport and ownership protocol behind the same `ConversationAgent` interface.
- OAuth/subscription-based providers, custom OpenAI-compatible endpoints, attachments, image input, voice input, branching, and session export/import are not part of the first backend slice.
- Retention, export, and recoverable deletion policies should be specified before shipping user data broadly.

## Reference material

- [Pi SDK documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi provider documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
- [Pi custom model documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
