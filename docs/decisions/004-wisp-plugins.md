# ADR 004: Plugin connections and per-Wisp access

- Status: Accepted
- Date: 2026-09-07 (updated 2026-10-04 to include Tavily and Exa and per-capability web providers)
- Decision owners: Wisp product and security boundary
- Scope: Bundled Brave Search, Linear, Firecrawl, Tavily, and Exa integrations

## Decision

Configure plugin connections globally in **Settings → Plugins**, then grant each
Wisp access independently through its **Access** tab. A saved connection does not
grant access automatically. The catalog contains Brave Search, Linear,
Firecrawl, Tavily, and Exa, with one API-key connection per plugin on the device.

The connection form accepts a new key without reading the saved secret back.
**Connect** and **Replace key** test an entered key and persist it only after
the test succeeds; **Test connection** checks the saved key. Enabling or
disabling a connected plugin applies immediately.
Brave testing performs one search request; Linear testing reads the authenticated
viewer. Firecrawl tests credit usage; Tavily tests API-key usage without a paid
search or extraction. Exa tests one search result without content extraction,
which can consume credits. A successful connection test does not guarantee access to every resource
or permission to write.

## Capabilities and endpoints

| Plugin | Access | Tools |
| --- | --- | --- |
| Brave Search (`web-search`) | `none`, `read` | `web_search`: titles, URLs, and snippets |
| Linear | `none`, `read`, `write` | `linear_search_issues`, `linear_get_issue`, `linear_list_teams`, `linear_list_statuses`; write also enables `linear_create_issue` and `linear_update_issue` |
| Firecrawl | `none`, `read` | `web_search` and `web_read`: search for sources and read a web page as bounded Markdown; no browser interaction or arbitrary POST |
| Tavily | `none`, `read` | `web_search` and `web_read`: basic search with source snippets and single-page Markdown extraction |
| Exa | `none`, `read` | `web_search` and `web_read`: automatic search with bounded highlights and single-page content retrieval |

Brave calls `GET https://api.search.brave.com/res/v1/web/search` with the API key
in `X-Subscription-Token`, following the [Web Search documentation](https://api-dashboard.search.brave.com/documentation/services/web-search).
Linear uses fixed GraphQL operations at `POST https://api.linear.app/graphql`
with the personal API key in `Authorization`, following the [GraphQL documentation](https://linear.app/developers/graphql).
The adapters do not accept caller-supplied endpoints or GraphQL documents.
Firecrawl calls `POST https://api.firecrawl.dev/v2/search` and `/v2/scrape`
with a Bearer API key, returning sources or page Markdown with response size limits.
Tavily calls `POST https://api.tavily.com/search` and `/extract`, with its API
key in `Authorization: Bearer`; testing uses `GET /usage`. Exa calls
`POST https://api.exa.ai/search` and `/contents`, with its key in `x-api-key`.
See [Tavily's API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
and [Exa's API reference](https://exa.ai/docs/reference/search).

`web_search` and `web_read` are shared capabilities. Each Wisp stores one
provider per capability (`webProviders`), and every chosen provider must also
hold a `read` grant so revocation, key replacement, and removal keep working
per plugin. A chosen provider that is turned off or disconnected makes the
capability unavailable rather than falling back to another provider; removing
a connection clears it from every Wisp's choices. Wisps saved before explicit
choices existed use the first granted, connected provider in catalog order
(Brave → Firecrawl → Tavily → Exa) until their access is saved again.
A global default provider per capability only orders the choices in the Access
tab; it never grants or changes a Wisp's provider. Shared web tools are
registered once, and failed requests are never retried automatically against
another paid provider.

The plugin ID `web-search` is kept for Brave Search so saved grants remain
valid; only its display name changed.

Linear updates support title, description, status, and priority. Read operations
are bounded and paginated where applicable. Requests reject redirects, enforce
timeouts and response limits, and return sanitized failures. External search and
issue content is model input, not authorization or executable instructions.

## Architecture and permissions

- `shared/plugins.ts` defines the catalog, connection summaries, and grant/IPC
  contracts. `shared/tool-catalog.ts` supplies common tool metadata for runtime
  allowlisting, events, and session reports.
- Main-process `PluginService` owns adapters, credential access, grant validation,
  and execution. Validated, sender-checked IPC exposes configuration and access
  operations; the renderer does not execute integrations.
- `plugins.json` stores versioned enabled states, grants, per-Wisp web
  provider choices, and default providers under Electron's
  user-data directory. `plugin-credentials.enc.json` stores encrypted keys through
  `EncryptedCredentialStore`, separately from model credentials. Secure storage
  must be available to persist new keys. Corrupt plugin configuration recovers
  with plugins disabled and access denied.
- Settings written before Firecrawl, Tavily, or Exa are loaded with those
  missing plugins disabled, preserving existing connections and grants.
- Grants are keyed by the Wisp's immutable application session ID. Deleting and
  recreating a conversation with the same visible ID cannot inherit old grants.
- Access forms carry an opaque revision bound to both plugin configuration and
  Wisp identity. Stale saves are rejected and require an explicit reload; old
  drafts cannot silently restore grants after revocation or account replacement.
- Pi registers controlled tool definitions and refreshes active names before
  messages. Newly granted tools become available on the next message. Every call
  checks live grants, enabled state, and Wisp identity again in the backend.
- Linear mutations require `write` access and an expiring, single-use approval
  through the existing authorization broker under `external_write` /
  `integration`. Workspace auto-review rules cannot allow integration writes.
  Access is rechecked after approval, before sending the provider request.
- Events and reports recognize the bundled tools without exposing raw tool
  payloads, returned content, or credentials. Approval cards describe the bounded
  integration operation separately from file changes.

Disabling retains grants but blocks execution. Replacing an actual key or
removing a connection clears that plugin's grants before changing the secret.
Revocation cancels affected pending work, including approval waits and network
requests. Cancellation cannot roll back a mutation already accepted remotely;
uncertain write outcomes instruct the agent to check Linear before retrying.
Unreadable plugin credentials disable integration tools without preventing core
Wisp conversations. Revocations and disabling remain possible; the settings UI
reports the credential problem without exposing its contents.

## Extension boundary

Add another supported integration by extending the shared catalog/tool metadata,
implementing a typed backend adapter, and adding its configuration UI and tests.
The service supplies credential storage, per-Wisp authorization, and cancellation.
Arbitrary plugin installation, custom endpoints, OAuth for bundled plugins, and
multiple accounts are deferred. Remote MCP connections are covered separately
by [ADR 005](005-remote-mcp-servers.md). Pi's automatic discovery of project extensions, skills, prompts,
and context files remains disabled; these bundled tools do not enable shell or
PowerShell access.

## Validation scope

Automated coverage uses mocked provider HTTP responses and test credentials. It
checks adapter requests, input/response limits, sanitized errors, encrypted
persistence, denial and isolation of grants, revocation around approvals, Pi
tool availability, IPC validation, and settings interactions. These tests do not
constitute live authenticated verification against the bundled providers.
