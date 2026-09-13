# MCP integration analysis

Date: 2026-09-12. Status: proposal; application behavior is unchanged.

## Recommendation

Manage connections globally in **Settings → Integrations**, with separate
**Plugins** and **MCP servers** groups. Keep access in each **Wisp → Access** tab.
Adding a server must grant no Wisp access automatically.

Implement a dedicated `McpService` alongside `PluginService`, sharing a small
application-owned tool registry and authorization contracts. Preserve the bundled
adapters and their existing grants. Arbitrary MCP servers have dynamic tools,
transports, credentials, and trust assumptions that do not fit `PluginId` or the
current API-key adapter interface.

The first release supports remote MCP servers over Streamable HTTP, including
OAuth, configured authentication headers, and unauthenticated connections where
appropriate. Local stdio servers and process launching are deferred. Specific
remote server examples remain useful for authentication and interoperability
testing. Legacy HTTP+SSE transport can be evaluated separately if a target server
requires it; it is not part of the initial implementation.

## Existing foundation

| Area | Current implementation | MCP implication |
| --- | --- | --- |
| Connection settings | `shared/plugins.ts`, `src/components/plugin-settings-section.tsx` | Reuse the global connection/per-Wisp access interaction; supply a dynamic server list. |
| Grants and execution | `electron/backend/plugin-service.ts` | Preserve immutable application session identity, default denial, stale-save protection, live access checks, and cancellation. |
| Secrets | `electron/backend/encrypted-credential-store.ts` | Reuse encryption and atomic writes, with a separate typed MCP secret store. The current credential types are coupled to Pi model authentication. |
| IPC | `electron/ipc/register-plugin-handlers.ts`, `shared/contracts.ts`, `electron/preload.ts`, `src/lib/wisp-bridge.ts` | Add narrow validated MCP configuration/access operations with the same sender checks. |
| Agent tools | `electron/backend/pi-conversation-agent.ts` | Replace fixed plugin-only discovery with a trusted registry snapshot. |
| Approvals | `electron/backend/tool-authorization-broker.ts`, `shared/tool-policy.ts` | Support generic integration calls and stable server/tool identities. |
| Activity and history | `shared/tool-catalog.ts`, `electron/backend/pi-event-translator.ts`, `electron/backend/pi-session-report.ts` | Support dynamic metadata and retain historical identity after server removal. |

The plugin service already revokes grants on account-key replacement, denies
recreated Wisps with reused conversation IDs, cancels affected calls, and checks
access again after approval. Those are valuable invariants to retain.

## User experience and data model

The MCP list should show the user-assigned name, endpoint, enabled state,
authentication state, last successful discovery, and available tool count.
Distinguish **configured**, **connected**, **needs sign-in**, and **unavailable**.

An Add/Edit form should provide:

- Endpoint URL and authentication mode; secrets entered through password
  fields or a browser sign-in flow.
- Actions: Test connection, Save, Enable/Disable, Refresh tools, and Remove.
  Testing initializes/discovers capabilities without invoking an arbitrary tool
  or granting access. A draft test connection is disposed afterward.

In Wisp Access, show each connection independently, including multiple accounts
for the same service. Default to **No access**. For the first release, offer
**Use with approval** and a preview of the reviewed tool set. Later, add selected
tools and explicit automatic-call permissions for trusted operations. New or
materially changed tool definitions need review; they must not silently inherit
an automatic permission.

Suggested persisted records:

| Record | Main fields |
| --- | --- |
| Server configuration | Immutable `serverId`, display name, Streamable HTTP endpoint, authentication mode, enabled state, `configRevision`, `credentialRef`. |
| Secret bundle | Authentication header values; OAuth tokens, expiry, and required client registration data. Never returned by settings reads. |
| Tool snapshot | Original tool name, app-generated alias, bounded description/schema, definition fingerprint, discovery time. |
| Wisp grant | Immutable application `sessionId`, `serverId`, reviewed tools/fingerprints, call policy, grant revision. |

Use a separate versioned `mcp-servers.json` and encrypted MCP credentials file
initially. Leave `plugins.json` compatible. A UI rename does not require a risky
storage migration. The backend can compose both services into one settings view.

Use revisions scoped to the affected server and Wisp. Endpoint, authentication
configuration, or account replacement invalidates access and pending
calls. Renaming should preserve identity. Routine OAuth refresh should preserve
grants when the account and authorization scope are unchanged. Disabling blocks
execution while retaining grants; removal deletes grants and tears down clients.

## Runtime integration

### The fixed registry is the principal implementation obstacle

`SdkPiSessionFactory.create()` registers plugin definitions once and rejects names
without static plugin metadata. It captures `registeredPluginNames`, then only
refreshes which of those names are active before prompts and after reload.

The installed Pi 0.84.4 implementation retains a registry allowlist and its
initial custom-tool definitions. Its documented `setActiveToolsByName()` ignores
unknown names. Consequently, calling that method or the current `reload()` cannot
make a newly discovered MCP tool available.

Introduce an asynchronous tool-source interface returning definitions, safe
metadata, active names, and a snapshot revision. Compose built-ins, bundled
plugins, and MCP through that interface. Keep the fixed built-in catalog; extend
it with backend-validated integration metadata rather than accepting arbitrary
names or checking only an `mcp_` prefix.

For the first implementation, rebuild the Pi session at an idle message boundary
when definitions change, reopening the exact current Pi session file and
preserving application identity, model selection, context settings, and event
subscriptions. Do not start a new conversation or new topic. Prove this with the
real installed SDK before building the full UI. A public SDK facility for replacing
definitions could be evaluated as an alternative, but do not mutate private SDK
fields or enable automatic project extension discovery.

Grant reductions must take effect immediately in the backend, even if the model
still sees the previous turn's definitions. Grant increases and new definitions
become visible on the next message. Schema changes invalidate the old wrapper
instead of dispatching old-schema calls to a changed server.

### Tool bridge and connection lifecycle

Use the official TypeScript SDK for transport and protocol handling. Its current
v2 client package is `@modelcontextprotocol/client`. Use its Streamable HTTP
transport, pin the tested version, and verify Electron packaging and CommonJS/ESM loading.
The existing Pi dynamic-import approach provides a useful precedent.
[SDK connection documentation](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
and [v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/).

The bridge should:

1. Connect lazily with bounded initialization/discovery deadlines. A failed server
   must not prevent a Wisp from using its built-in tools.
2. Discover all bounded pages, validate schemas, and assign deterministic aliases
   using immutable server IDs plus collision-checked tool identifiers. Preserve
   the original name for dispatch. Never let a server shadow `read` or `write`.
3. Handle advertised tool-list changes through the SDK's negotiated protocol
   support. Keep stable ordering and cap tool count, schema size, description
   length, and total tool-context budget.
4. Validate arguments against the reviewed schema, capture immutable arguments,
   check Wisp/server/tool permissions, obtain approval when required, then recheck
   permissions and configuration generation immediately before dispatch.
5. Translate text and structured results with explicit size bounds and preserve
   error semantics. An MCP `isError` result must not appear as successful activity
   in Pi. Return a clear unsupported-content outcome for unimplemented image,
   audio, or resource formats; do not fetch resource links automatically.
6. Propagate cancellation and close clients on removal/disposal, including remote
   session cleanup where supported. Reconnect with backoff, but never replay a
   possibly completed tool mutation automatically. Report uncertain outcomes explicitly.

Discovery, namespacing, result types, and untrusted annotations are covered by the
[MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Keep transport clients separate per Wisp and server/configuration generation
initially, especially for servers using stateful protocol revisions. Share only
appropriate credential/discovery infrastructure. Separate clients do not isolate
data in the same remote account; per-Wisp grants control Wisp's use of that
account. More aggressive sharing can follow demonstrated server compatibility.

Persist safe tool identity/labels with session history. Otherwise deleting a
server could make old calls disappear from reports. Send sanitized metadata and
status changes to the renderer; raw credentials and server diagnostics stay out
of IPC responses, activity events, and audit records. Do not add a renderer-facing
arbitrary `callTool` method.

## Authorization and execution boundaries

Bundled plugin `read`/`write` labels are application-owned classifications of
specific adapters. MCP annotations are supplied by the server. The specification
explicitly treats them as untrusted unless the server is trusted. Wisp should
therefore avoid presenting generic MCP access as guaranteed “Read only.”
[MCP tool annotations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool).

Add a generic integration-call policy category with `ask` as its initial behavior,
separate from workspace auto-review and known external mutations. Read-like calls
can still transmit sensitive arguments or incur charges. Approval should identify
the Wisp, connection, actual tool, and a bounded argument preview. Host-generated
labels and the immutable argument snapshot should define what is approved;
server-provided prose is descriptive data, not authorization.

For remote endpoints, enforce a deliberate URL/network policy: HTTPS server URLs,
no URL credentials, and no forwarding
secrets across redirects. Apply destination validation to authentication discovery
as well as tool traffic. Keep configured authentication secrets out of model
context. User-controlled labels, tool descriptions, and results remain untrusted.

For OAuth, use SDK support plus an Electron browser/callback adapter: discovery,
PKCE, request/issuer validation, resource-scoped tokens, encrypted persistence,
serialized refresh, and recoverable sign-in status. Avoid embedding a client
secret in the desktop app. Account changes invalidate Wisp grants; token renewal
alone does not. Follow the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Local stdio support is a future extension requiring a separate process execution
and confinement design. The initial settings forms, persistence contracts, and
IPC accept only remote connection configuration. Reject command, argument,
working-directory, and environment configuration rather than adding dormant
process-launching paths. An OAuth loopback callback, if used, is authentication
infrastructure and does not add local MCP server support.

Scope the initial feature to tools. Resources, prompts, embedded MCP UI,
server-requested model sampling, elicitation/input-required interactions, and
long-running task workflows need their own designs. Advertise only supported
client capabilities and fail clearly for unsupported interaction requests.

## Plugin findings

These findings concern the current implementation, not hypothetical MCP code.

### 1. Unreadable credentials cannot be repaired through settings

If the encrypted credential file remains corrupt, `getView()` reports every
plugin as unconfigured. Saving a replacement key first calls `readKey()` and fails
on the same file. Removing a credential also requires reading the file, and the
UI hides Remove when `configured` is false. Disabling and grant revocation work,
but users cannot reconnect through the app.

Evidence: `plugin-service.ts:122`, `plugin-service.ts:146`,
`encrypted-credential-store.ts:99`, `encrypted-credential-store.ts:122`,
`plugin-settings-section.tsx:269`. Existing tests cover safe disabling, not repair.

Add an explicit recovery operation for unreadable storage that first disables
affected integrations and revokes grants, then quarantines/resets the encrypted
file. Explain that resetting a shared store affects all its saved connections;
do not silently overwrite a potentially recoverable keychain failure.

### 2. “Always block” applies to every Wisp's integration writes

The approval card appears in the context of one tool call, but its block action
persists a global `external_write` category rule. It blocks both Linear mutations
for all Wisps. Reusing this behavior for MCP would also block unrelated servers.

Evidence: `tool-approval-card.tsx:33`, `tool-authorization-broker.ts:136`,
`tool-policy-store.ts:48`, and `tool-authorization-broker.ts:267`.

This is a scope/UX mismatch, not a permission bypass. Either label the current
action “Block all integration writes,” or persist explicit Wisp/server/tool scope.
Use stable IDs, not display labels, for new rules.

### 3. Unrelated saves invalidate another Wisp's access form

Every plugin commit rotates one global revision. An access form for Wisp A becomes
stale when Wisp B's grants change, or even when unchanged connection settings are
saved. The rejection is conservative but creates unnecessary lost drafts/reloads.

Evidence: `plugin-service.ts:365` and `plugin-service.ts:398`. Use a Wisp grant
revision plus revisions of the connections covered by its form, preserving stale
save rejection for relevant account changes and revocations.

### 4. Write approvals omit most proposed values

`mutationSummary()` shows a target, a shortened title, and changed field names.
Description content, status destination, and priority value are absent. The user
can approve “Update issue … (description)” without seeing what will be sent.

Evidence: `plugin-adapters.ts:274` and `tool-approval-card.tsx:24`.
Provide an expandable bounded field preview for bundled writes, then reuse that
pattern for MCP arguments. Keep previews out of broad telemetry and redact actual
credential fields. This is an informed-approval limitation rather than evidence
that the existing backend executes different arguments from those it captured.

ADR 004 also still describes only Brave and Linear, while the implementation
includes Firecrawl. Update it when recording the new integration decision.

## Implementation sequence and acceptance checks

1. Prove dynamic tool snapshots and Pi session recreation with an in-memory MCP
   fixture and the real Pi SDK. Verify history, model, context, and subscriptions
   survive and shell/project discovery remains disabled.
2. Add server/secret/grant storage, input validation, immutable identities,
   configuration generations, and narrow IPC. Preserve bundled plugin behavior.
3. Implement remote discovery/calls, result conversion, connection lifecycle,
   cancellation, and authorization, including OAuth sign-in, callback validation,
   refresh, and reconnection.
4. Build global MCP settings and per-Wisp access, with health updates, stale-draft
   reloads, reviewable approvals, and dynamic activity/report metadata.
5. Verify remote connections and OAuth in packaged macOS and Windows builds,
   including browser sign-in, callbacks, secure storage, reconnect, and disposal.
   Local stdio and additional protocol features remain explicit follow-ups.

Required tests include two Wisps/two servers with colliding tool names; adding a
server after a session exists; new/changed/removed tools; revocation before and
after approval; endpoint/account replacement; delete/recreate Wisp isolation;
unavailable servers; corrupt-secret recovery; paginated/malformed/oversized
discovery; error results; timeouts and uncertain writes; reconnect without replay;
OAuth callback/refresh isolation; remote-session cleanup; and rejection of local
process configuration at the IPC boundary.
Verify reports still identify old tools after a connection is removed.

Validation performed for this analysis: 105 tests passed across ten focused
suites covering plugin service/adapters/IPC, settings/access UI, SDK factory,
authorization, event translation, session reports, and real Pi SDK session
isolation/reopening. These tests use controlled
fixtures and do not establish live compatibility with an authenticated MCP server.
