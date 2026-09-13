# Bundled plugins

Wisp ships with three bundled integrations: **Brave Search** (web search),
**Linear**, and **Firecrawl**. Connections are configured globally in
**Settings → Plugins**; each Wisp receives access independently through its
**Access** tab. Connecting a plugin grants no Wisp access automatically.

For dynamically discovered integrations, see [remote MCP servers](mcp-servers.md).

## Connecting a plugin

Open **Settings → Plugins**, enter a **Brave Search API key**, **Linear
personal API key**, or **Firecrawl API key**, optionally select **Test
connection**, and select **Save plugin** with the plugin enabled. Testing
checks the entered key, or the saved key when the field is blank; it does not
save a new key. Each plugin supports one connection on this device.

- Brave testing performs one search request.
- Linear testing reads the authenticated viewer.
- Firecrawl testing checks credit usage without scraping.

A successful connection test does not guarantee access to every resource or
permission to write.

## Per-Wisp access

Open a Wisp's **Access** tab, choose **Read only** for web search or Firecrawl,
**Read only** / **Read and write** for Linear, and select **Save access**.
Every Wisp starts with **No access**. New tools become available on its next
message. Linear issue creation and updates still require an **Allow once**
approval before execution, regardless of file auto-review rules.

## Capabilities

| Plugin | Category | Access levels | Tools |
| --- | --- | --- | --- |
| Brave Search | Web & research | `none`, `read` | `web_search` |
| Linear | Productivity | `none`, `read`, `write` | `linear_search_issues`, `linear_get_issue`, `linear_list_teams`, `linear_list_statuses`; write also enables `linear_create_issue` and `linear_update_issue` |
| Firecrawl | Web & research | `none`, `read` | `firecrawl_scrape` |

Web search returns titles, source URLs, and snippets through the
[Brave Search API](https://api-dashboard.search.brave.com/documentation/services/web-search);
it does not browse pages or fetch arbitrary URLs. Linear can search/read
issues, list teams and statuses, and create/update issues through its
[GraphQL API](https://linear.app/developers/graphql). `firecrawl_scrape` reads
one HTTP(S) page as Markdown (long content is truncated) using the
[Firecrawl v2 scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape);
scraping uses Firecrawl credits. The connected key's own permissions also apply.

## Revocation and key changes

Disabling a plugin blocks all Wisps but retains their grants. Replacing a key
with a different key or removing its connection clears every Wisp's grants for
that plugin. Revocation blocks new calls and cancels pending
approvals/requests; it cannot undo a change already accepted by Linear. Check
Linear before retrying a write whose outcome is uncertain.

## Extension boundary

These three bundled plugins plus remote MCP servers are the supported
integrations. Arbitrary plugin installation, custom endpoints, and multiple
accounts per plugin are not available yet. See
[ADR 004](decisions/004-wisp-plugins.md) for the connection model, adapter
boundaries, and validation scope.
