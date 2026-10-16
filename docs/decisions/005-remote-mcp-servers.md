# ADR 005: Remote MCP server integrations

- Status: Accepted
- Date: 2026-09-12
- Decision owners: Wisp product and security boundary
- Scope: Dynamically discovered integrations via remote MCP servers
- Related: [ADR 004](004-wisp-plugins.md), [MCP integration analysis](../mcp-integration-analysis.md)

## Decision

Support remote [MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
servers as dynamic integrations alongside the bundled plugins, managed globally in
their own **Settings → MCP servers** panel (bundled plugins stay in
**Settings → Plugins**). Adding a server never grants any Wisp access; grants stay
per-Wisp in each **Access** tab with a single first-release level,
**Use with approval**.

The first release covers Streamable HTTP endpoints with three authentication
modes: none, a configured authentication header, and OAuth browser sign-in.
Local stdio servers are out of scope: command, argument, working-directory, and
environment configuration is rejected at every boundary instead of lying dormant.
Resources, prompts, embedded MCP UI, server-requested sampling, elicitation, and
long-running tasks are deferred; the client advertises no such capabilities and
fails unsupported interaction requests clearly.

## Architecture

- The official TypeScript SDK (`@modelcontextprotocol/client`, pinned) provides
  the Streamable HTTP transport, protocol negotiation, pagination, and OAuth
  helpers. The bridge (`mcp-bridge.ts`) keeps the SDK behind a structural
  surface so tests can drive connections in memory.
- `McpService` owns persistence (`mcp-servers.json`, versioned), a dedicated
  encrypted secret store (`mcp-credentials.enc.json` for header values, OAuth
  tokens, and dynamic client registration), per-Wisp grants, and execution.
  Bundled plugin storage stays untouched.
- OAuth uses the SDK's provider contract with a loopback callback, PKCE, issuer
  validation, and a public client; no client secret is embedded. Token refresh
  never removes Wisp access; replacing the account or endpoint does.
- `IntegrationToolSource` is the async abstraction every tool provider
  implements (bundled plugins, MCP). It returns definitions, application-owned
  display metadata, active names, and a revision covering both grants and
  definition fingerprints.

## Tool availability and the Pi registry

Pi's tool registry is a permanent allowlist: names cannot be added after a
session is created, and its documented `setActiveToolsByName` ignores unknown
names. Therefore a snapshot change (new server granted, tools added or changed,
server removed) is applied by **rebuilding the Pi session at an idle message
boundary**: the next message triggers the rebuild, which reopens the exact
current Pi session file and preserves application identity, model selection,
context settings, and event subscriptions. No new conversation or topic starts.
Grant reductions remain effective immediately in the backend through the
execution-time rechecks, independent of what definitions the model still sees.
Schema changes replace the wrapper instead of dispatching stale arguments.

Discovered tools get deterministic aliases derived from the immutable server ID
plus the original tool name (`mcp_<server>_<tool>`), so renames preserve
identity, two servers cannot shadow each other, and built-ins or bundled plugin
tools cannot be shadowed. Dispatch always uses the original server tool name.
Metadata (labels, activity labels, `integration_call` category) is registered in
the shared tool catalog only after this derivation is validated; the catalog
never accepts arbitrary names or a bare `mcp_` prefix.

## Authorization boundaries

MCP tool annotations are server-supplied and untrusted, so MCP calls never map
to "read" or "write" access levels. They run under a new generic
`integration_call` policy category whose initial behavior is always to ask;
policy rules may block but never auto-allow it. Approvals identify the Wisp,
connection, aliased tool, and a bounded argument preview with secret-like keys
redacted; host-generated labels and the immutable argument snapshot define what
was approved. Access, enablement, and configuration generation are rechecked
after the approval wait, immediately before dispatch, and dispatch is never
replayed automatically after an interruption: uncertain outcomes are reported as
such.

### Amendment (2026-10-08): always allow one tool for one Wisp

Asking before every call proved too disruptive: Wisps that use MCP make many
calls per turn, and each one stopped the flow. As anticipated by the
[MCP integration analysis](../mcp-integration-analysis.md), the approval card
now offers **Always allow this tool**. The decision stays narrow so it does not
reintroduce trust in server-supplied annotations:

- It is stored by `McpService` per Wisp, server, and original tool name, bound
  to the fingerprint of the reviewed definition (name, description, input
  schema). It is not a policy rule, and policy rules still cannot allow
  `integration_call`.
- A changed definition asks again; every commit prunes permissions whose tool
  changed or disappeared, whose Wisp lost access, or whose server was removed
  or re-identified.
- The broker honors it only for `integration_call` with integration scope and
  only after policy evaluation, so a Block rule still wins. Remembered calls are
  audited as `allow_always` by the user.
- Saving is refused if access, the connection, or the tool changed while the
  card was open; the call itself is still allowed once.
- Access forms list always-allowed tools and can remove them but never add
  them, and the list is part of the access revision.

### Amendment (2026-10-16): additional headers and presets

Some servers take options in headers, such as GitHub's `X-MCP-Toolsets`. A
connection can now carry up to 8 **additional headers**, sent with every
request in every authentication mode:

- They are configuration, not secrets: stored in `mcp-servers.json` and shown
  in the view. Names that look like credentials are refused so a token is not
  stored there by mistake, and headers owned by the transport or protocol are
  refused. The authentication header wins over an additional header of the
  same name.
- Changing them is not an identity change. It bumps the configuration
  generation (closing clients and failing approvals in flight), drops the tool
  snapshot, and discovers again, but keeps grants and enablement: the server
  still acts as the same account.

A **preset** adds a known server with its endpoint, authentication, and
options filled in; the first is GitHub's official server with a personal
access token and toolset selection. A preset is recorded on the connection
when it is added and never changes. Preset connections are presented as
plugins: they are managed in **Settings → Plugins** and listed with the apps in
a Wisp's **Access** tab, not under MCP servers, because users look for GitHub
among the plugins. Only the presentation moves; storage, grants, and the
access levels stay those of MCP (see the amendment to
[ADR 004](004-wisp-plugins.md)). Its tools are ordinary MCP tools with the
same grants and approvals; annotations stay untrusted, so read tools are not
allowed automatically. The user chose one connection with per-tool **Always
allow** over a read-only connection plus a write connection.

A preset also brings an application-owned skill (the plugin's skill), offered
to Wisps with access to an enabled connection that has discovered tools. See
the amendment to [ADR 008](008-wisp-skills.md).

Endpoint URLs must be HTTPS without embedded credentials. Authentication
secrets stay in the main process and never appear in IPC responses, activity
events, reports, or model context. Safe tool identity is persisted with session
history (`wisp:mcp-tools` entries) so reports keep identifying past calls after
a server is removed. MCP results are bounded, `isError` results surface as
failed tool calls, and images, audio, and resources are reported as unsupported
instead of fetched.

### Amendment (2026-10-16): OAuth sign-in with a server on another computer

The loopback callback only works where the browser runs. With the server on
another computer (such as a Raspberry Pi used from the desktop app), the
browser and the server are on different machines. The server now picks the
sign-in browser for the device that started the sign-in:

- **Local device**: unchanged. The server listens on its loopback and asks the
  app to open the browser.
- **Desktop app elsewhere**: the app listens on its own loopback and relays the
  redirect's query string through host requests (`oauthListen`,
  `oauthRedirect`, `oauthClose`), which a server may now send to that device.
  The client picks the port and answers before discovery and registration, so
  the redirect URI registered with the authorization server is the one that
  listens; no port has to be free on both computers. The app validates
  `state`, and the server validates it again. The PKCE verifier and tokens
  never leave the server.
- **Anything else** (browser app, phones, older apps that refuse the relay):
  the view exposes the authorization URL while the sign-in waits, and
  `finishMcpSignIn` accepts the redirect address the user pastes. It must have
  the callback path and this flow's `state`; anything else is refused without
  ending the sign-in. The server's own listener stays up, so a browser on the
  server's computer still works.

Cancelling, timeouts, configuration changes, and disconnects end the relay
listener as well as the flow: the server closes it, pending host requests fail
when their device's last event stream closes, the app closes its listeners when
it leaves the server, and every listener closes on its own after 10 minutes.
Device code flow is not added; it waits for a provider that needs it.

## Lifecycle

Connections are established lazily with bounded deadlines, per Wisp and
configuration generation. A failed server never prevents a Wisp from using its
built-in tools. Disabling blocks execution while retaining grants; changing the
endpoint, mechanism, or credential revokes grants, cancels pending calls, and
closes live clients; removal also deletes secrets and unregisters labels.
Access forms carry a revision scoped to the Wisp plus its granted servers, so
unrelated servers or other Wisps' changes never invalidate an open form, while
relevant changes still force a reload. Corrupt configuration recovers with
every server disabled and every Wisp denied.

## Validation scope

Automated coverage includes service persistence and recovery, validation and
stdio rejection, grants and revision scoping, colliding tool names across
servers, snapshots before and after grants, authorization and post-approval
rechecks, error results and redaction, OAuth needs-sign-in paths, bridge
connect/auth/result conversion with in-memory servers, composite tool-source
semantics, session rebuild preserving identity with the real installed Pi SDK,
and historical report identity. These tests use controlled fixtures and do not
establish live compatibility with an authenticated third-party MCP server.
Packaged-build verification of OAuth callbacks and reconnection remains a
follow-up.
