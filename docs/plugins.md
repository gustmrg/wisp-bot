# Bundled plugins

Wisp ships with three bundled integrations: **Brave Search** (web search),
**Linear**, and **Firecrawl** (web search and page reading). Connections are configured globally in
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
| Firecrawl | Web & research | `none`, `read` | `web_search`, `web_read` |

## Shared web tools

Web capabilities are independent of the selected LLM provider. Wisps use two
provider-independent tools backed by their connected, enabled, and granted plugins:

- `web_search({ query, count? })` finds sources and returns `provider`, `query`,
  `results` (titles, URLs, snippets), and `moreResultsAvailable`. Queries are
  limited to 500 characters and 75 words; `count` is 1–10 (default 5).
  Brave Search is preferred when both providers are available to that Wisp;
  otherwise Firecrawl supplies search. Firecrawl reports `moreResultsAvailable`
  as `null` because its API does not indicate additional results.
- `web_read({ url })` reads one HTTP(S) URL as Markdown through Firecrawl,
  returning `provider`, `url`, `title`, `markdown`, and `truncated`. URLs are
  limited to 2,000 characters and must not contain credentials. It does not
  search, click, or fill forms. Page text is bounded to 20,000 characters.

Search registers only once even when both plugins are connected. Provider
selection is checked again for every call against that Wisp's current grants;
a denied plugin is never used. Failures are returned without automatically
retrying on another provider. Search and reading can consume provider credits.
Connecting Firecrawl alone and granting **Read only** enables both web tools;
connecting only Brave enables search but not page reading. Existing Firecrawl
grants apply to the new capabilities without reconfiguration.

`web_read` replaces the former `firecrawl_scrape` tool name. Saved activity and
usage reports still recognize the old name, but new sessions advertise `web_read`.

Web search returns titles, source URLs, and snippets through the
[Brave Search API](https://api-dashboard.search.brave.com/documentation/services/web-search);
it does not browse pages or fetch arbitrary URLs. Linear can search/read
issues, list teams and statuses, and create/update issues through its
[GraphQL API](https://linear.app/developers/graphql). `web_read` reads
one HTTP(S) page as Markdown (long content is truncated) using the
[Firecrawl v2 scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape);
scraping uses Firecrawl credits. Firecrawl-backed `web_search` uses the
[Firecrawl v2 search API](https://docs.firecrawl.dev/api-reference/endpoint/search)
without scraping every result. The connected key's own permissions also apply.

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
