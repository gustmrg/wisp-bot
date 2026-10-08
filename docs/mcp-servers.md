# Remote MCP servers

Wisp can connect to remote
[Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
(MCP) servers as dynamically discovered integrations, alongside the
[bundled plugins](plugins.md). Servers are managed in their own
**Settings → MCP servers** panel; bundled plugins stay in **Settings → Plugins**.

## Adding a server

The first release covers Streamable HTTP endpoints (must be HTTPS, without
embedded credentials) with three authentication modes:

- **None** — no authentication.
- **Authentication header** — a configured header value stored encrypted.
- **OAuth** — browser sign-in with PKCE over a loopback callback and a public
  client; no client secret is embedded. A sign-in opens exactly one browser
  window and can be cancelled while it waits — also after leaving the panel
  and coming back, and before the browser has opened; cancelling never changes
  grants or stored credentials. Removing the connection or changing its
  endpoint or authentication ends a waiting sign-in, and credentials from a
  sign-in that finished for the old configuration are discarded.

Local stdio servers are rejected at every boundary, along with resources,
prompts, embedded MCP UI, server-requested sampling, and long-running tasks;
unsupported interaction requests fail clearly instead of lying dormant.
Discovery accepts at most 128 tools per server and fails clearly beyond that.
That is a per-server bound, not a per-Wisp one: a Wisp's built-in, plugin, and
granted MCP tools are all sent to the model together, and some models accept
fewer (OpenAI models reject more than 128). When a model refuses the request
for that reason, the chat says so and points to the Access tab.

## Per-Wisp access

Adding a server never grants any Wisp access. Grants are per-Wisp, with a
single first-release level, **Use with approval**. They can be chosen in each
Wisp's **Access** tab, or for every Wisp at once in the server's **Wisp access**
section under **Settings → MCP servers**, which opens right after a server is
added. Both edit the same grants. Granting requires an enabled connection, and
a completed sign-in for OAuth. Every
MCP tool call asks before execution: server-supplied tool annotations are
untrusted, so policy rules may block these calls but never auto-allow them.
Approvals identify the Wisp, connection, tool, and a bounded argument preview
with secret-like keys redacted.

Tools get deterministic aliases derived from the immutable server ID plus the
original tool name, so server-side renames preserve identity and two servers
cannot shadow each other, the built-in tools, or bundled plugin tools.

When a snapshot changes (a new server is granted, tools are added or changed,
or a server is removed), the change is applied by rebuilding the Wisp's Pi
session at the next idle message boundary: the next message triggers the
rebuild, which preserves conversation identity, model selection, and context
settings — no new topic starts. Grant reductions take effect immediately in the
backend, independent of the definitions the model still sees.

## Lifecycle and revocation

Connections are established lazily with bounded deadlines. A failed server
never prevents a Wisp from using its built-in tools. Disabling a server blocks
execution while retaining grants. Changing the endpoint, authentication
mechanism, or credential revokes every Wisp's grants, cancels pending calls,
and closes live clients; removal also deletes stored secrets. Corrupt
configuration recovers with every server disabled and every Wisp denied.

OAuth token refresh never removes Wisp access; replacing the account or
endpoint does.

## Security notes

- Authentication secrets stay in the main process and never appear in IPC
  responses, activity events, reports, or model context.
- Access, enablement, and configuration are rechecked after the approval wait
  and immediately before dispatch; dispatch is never replayed automatically
  after an interruption, and uncertain outcomes are reported as such.
- MCP results are bounded; `isError` results surface as failed tool calls, and
  images, audio, and resources are reported as unsupported rather than fetched.
- Safe tool identity is persisted with session history, so usage reports keep
  identifying past calls after a server is removed.

See [ADR 005](decisions/005-remote-mcp-servers.md) for the full decision and
validation scope.
