# ADR 004: Plugin connections and per-Wisp access

- Status: Accepted
- Date: 2026-09-07 (updated 2026-09-12 to include Firecrawl)
- Decision owners: Wisp product and security boundary
- Scope: Bundled Brave Search, Linear, and Firecrawl integrations

## Decision

Configure plugin connections globally in **Settings → Plugins**, then grant each
Wisp access independently through its **Access** tab. A saved connection does not
grant access automatically. The catalog contains Brave Search, Linear, and
Firecrawl, with one API-key connection per plugin on the device.

The connection form accepts a new key without reading the saved secret back.
**Test connection** checks an entered key or the existing saved key, without
persisting the entered value. **Save plugin** persists the key and enabled state.
Brave testing performs one search request; Linear testing reads the authenticated
viewer. A successful connection test does not guarantee access to every resource
or permission to write.

## Capabilities and endpoints

| Plugin | Access | Tools |
| --- | --- | --- |
| Web search | `none`, `read` | `web_search`: titles, URLs, and snippets; no page browser or arbitrary URL fetch |
| Linear | `none`, `read`, `write` | `linear_search_issues`, `linear_get_issue`, `linear_list_teams`, `linear_list_statuses`; write also enables `linear_create_issue` and `linear_update_issue` |
| Firecrawl | `none`, `read` | `firecrawl_scrape`: read a web page as Markdown with a bounded response; no crawling or arbitrary POST |

Brave calls `GET https://api.search.brave.com/res/v1/web/search` with the API key
in `X-Subscription-Token`, following the [Web Search documentation](https://api-dashboard.search.brave.com/documentation/services/web-search).
Linear uses fixed GraphQL operations at `POST https://api.linear.app/graphql`
with the personal API key in `Authorization`, following the [GraphQL documentation](https://linear.app/developers/graphql).
The adapters do not accept caller-supplied endpoints or GraphQL documents.
Firecrawl calls `POST https://api.firecrawl.dev/v1/scrape` with the API key in
`Authorization`, returning the page as Markdown with response size limits.

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
- `plugins.json` stores versioned enabled states and grants under Electron's
  user-data directory. `plugin-credentials.enc.json` stores encrypted keys through
  `EncryptedCredentialStore`, separately from model credentials. Secure storage
  must be available to persist new keys. Corrupt plugin configuration recovers
  with plugins disabled and access denied.
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
Arbitrary plugin installation, custom endpoints, MCP, OAuth, and multiple accounts
are deferred. Pi's automatic discovery of project extensions, skills, prompts,
and context files remains disabled; these bundled tools do not enable shell or
PowerShell access.

## Validation scope

Automated coverage uses mocked provider HTTP responses and test credentials. It
checks adapter requests, input/response limits, sanitized errors, encrypted
persistence, denial and isolation of grants, revocation around approvals, Pi
tool availability, IPC validation, and settings interactions. These tests do not
constitute live authenticated verification against Brave Search or Linear.
