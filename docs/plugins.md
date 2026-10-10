# Bundled plugins

Wisp ships with five bundled integrations: **Brave Search** (web search),
**Linear**, **Firecrawl**, **Tavily**, and **Exa** (the latter three support web
search and page reading). Connections are configured globally in
**Settings → Plugins**; each Wisp receives access independently through its
**Access** tab. Connecting a plugin grants no Wisp access automatically.

For dynamically discovered integrations, see [remote MCP servers](mcp-servers.md).

## Connecting a plugin

Open **Settings → Plugins**. Connected plugins are listed first, with an
**Enabled** switch and the number of Wisps that can use them; the rest are
listed under **Available** with what they provide (search, page reading, or
their category). Select a plugin, enter its **Brave Search API key**, **Linear
personal API key**, **Firecrawl API key**, **Tavily API key**, or **Exa API
key** (each form links to the provider page that issues it), and select
**Connect**. Connecting tests the key first and saves it only if the test
succeeds. Each plugin supports one connection on this device.

A connected plugin's page has **Test connection** for the saved key, **Replace
key** (which also tests the new key before saving it), and **Remove
connection**. Right after connecting, the same page lists your Wisps so you can
give them access without opening each one.

- Brave testing performs one search request.
- Linear testing reads the authenticated viewer.
- Firecrawl testing checks credit usage without scraping.
- Tavily testing checks API-key usage without searching or extracting a page.
- Exa testing performs one search with one result and no content extraction;
  this can consume search credits.

A successful connection test does not guarantee access to every resource or
permission to write.

## Per-Wisp access

Open a Wisp's **Access** tab. Under **Web**, choose a provider for **Search
the web** and for **Read web pages**; under **Apps**, choose **Read only** or
**Read and write** for Linear. Select **Save access**. Each plugin's page in
**Settings → Plugins** offers the same choices for every Wisp. Plugins that are
not connected or are turned off are summarized in one line that links to
Settings. Every Wisp starts with **No access**. New tools become available on
its next message. Creating or updating Linear issues and adding comments still
require an **Allow once** approval before execution, regardless of file
auto-review rules.

When more than one connected plugin can search or read pages, **Settings →
Plugins → Default web providers** sets which one is listed first and marked
as the default in each Wisp's Access tab. Changing the default does not change
the provider a Wisp already uses.

## Capabilities

| Plugin | Category | Access levels | Tools |
| --- | --- | --- | --- |
| Brave Search | Web & research | `none`, `read` | `web_search` |
| Linear | Productivity | `none`, `read`, `write` | `linear_search_issues`, `linear_get_issue`, `linear_list_comments`, `linear_list_teams`, `linear_list_statuses`, `linear_list_projects`, `linear_list_labels`, `linear_list_users`; write also enables `linear_create_issue`, `linear_update_issue`, and `linear_add_comment` |
| Firecrawl | Web & research | `none`, `read` | `web_search`, `web_read` |
| Tavily | Web & research | `none`, `read` | `web_search`, `web_read` |
| Exa | Web & research | `none`, `read` | `web_search`, `web_read` |

## Shared web tools

Web capabilities are independent of the selected LLM provider. Wisps use two
provider-independent tools backed by their connected, enabled, and granted plugins:

- `web_search({ query, count? })` finds sources and returns `provider`, `query`,
  `results` (titles, URLs, snippets), and `moreResultsAvailable`. Queries are
  limited to 500 characters and 75 words; `count` is 1–10 (default 5).
  Search uses the provider chosen for that Wisp. Firecrawl,
  Tavily, and Exa report `moreResultsAvailable` as `null` because their APIs
  do not indicate additional results.
- `web_read({ url })` reads one HTTP(S) URL as Markdown or plain text,
  returning `provider`, `url`, `title`, `markdown`, and `truncated`. URLs are
  limited to 2,000 characters and must not contain credentials. It does not
  search, click, or fill forms. Page text is bounded to 20,000 characters.
  Reading uses the provider chosen for that Wisp. Tavily Extract does not
  return a separate title, so its `title` is `null`.

Each web tool registers only once even when multiple plugins are connected.
Each Wisp chooses one provider per capability, and the chosen provider is also
granted `read`; the provider is checked again for every call against that
Wisp's current grants and connection state. If the chosen provider is turned
off or disconnected, the capability is unavailable: Wisp never falls back to
another paid provider, and failures are not retried elsewhere. Search and
reading can consume provider credits. Brave Search provides search only.

Wisps whose access was saved before per-capability choices existed keep their
grants and use the first granted, connected provider in catalog order (Brave
Search → Firecrawl → Tavily → Exa) until their access is saved again. Updating
from an older version preserves existing connections and grants; newly added
plugins start disabled with no Wisp access.

`web_read` replaces the former `firecrawl_scrape` tool name. Saved activity and
usage reports still recognize the old name, but new sessions advertise `web_read`.

Brave Search returns titles, source URLs, and snippets through the
[Brave Search API](https://api-dashboard.search.brave.com/documentation/services/web-search);
it does not browse pages or fetch arbitrary URLs. Linear works through its
[GraphQL API](https://linear.app/developers/graphql) (see
[Linear](#linear) below). `web_read` reads
one HTTP(S) page as Markdown (long content is truncated) using the
[Firecrawl v2 scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape);
scraping uses Firecrawl credits. Firecrawl-backed `web_search` uses the
[Firecrawl v2 search API](https://docs.firecrawl.dev/api-reference/endpoint/search)
without scraping every result. The connected key's own permissions also apply.

Tavily-backed `web_search` uses the
[Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
with basic search, without a generated answer or full result-page content.
`web_read` uses the
[Extract API](https://docs.tavily.com/documentation/api-reference/endpoint/extract)
for a single URL in Markdown format. Per-URL extraction failures are reported
as errors even when Tavily responds with HTTP 200.

Exa-backed `web_search` uses the
[Search API](https://exa.ai/docs/reference/search) with automatic search type
and bounded highlights for snippets. `web_read` uses the
[Contents API](https://exa.ai/docs/reference/get-contents) with text extraction,
without HTML tags, and bounded crawl time and content length. Both adapters
use fixed API endpoints and the same request limits and sanitized errors as
the other bundled plugins. Page content and highlights can consume credits.

## Linear

The Linear plugin covers the everyday issue workflow:

- `linear_search_issues` filters by text, team, status, project, label,
  assignee (`"me"`, `"none"`, or a user UUID), parent issue (UUID or
  identifier such as `ENG-123`), priority, and last update (`updatedSince`, an
  ISO 8601 date/date-time or a duration such as `-P7D`).
- Issue results include status, assignee, project, labels, parent, priority,
  estimate, and due date. `linear_get_issue` adds the description and up to 50
  sub-issues; `linear_list_comments` returns the discussion with authors and
  reply parents.
- `linear_list_teams`, `linear_list_statuses`, `linear_list_projects`,
  `linear_list_labels`, and `linear_list_users` return the UUIDs the other
  tools accept. User results include names and whether the user is the
  connected account, never email addresses.
- With write access, `linear_create_issue` sets status, priority, assignee,
  project, labels, parent (making a sub-issue), estimate, and due date.
  `linear_update_issue` changes the same fields; an empty string clears the
  assignee, project, parent, or due date, and labels are added
  (`addLabelIds`) or removed (`removeLabelIds`) without replacing the others.
  `linear_add_comment` posts a Markdown comment or reply.

The plugin is deliberately partial. Cycles, milestones, issue relations,
attachments, documents, project updates, and administrative operations are
not included, and it never deletes anything. Wisps that need them can use
Linear's official MCP server (`https://mcp.linear.app/mcp`) as a
[remote MCP server](mcp-servers.md), where every call is approved separately.

## Revocation and key changes

Disabling a plugin blocks all Wisps but retains their grants. Replacing a key
with a different key or removing its connection clears every Wisp's grants for
that plugin. Revocation blocks new calls and cancels pending
approvals/requests; it cannot undo a change already accepted by Linear. Check
Linear before retrying a write whose outcome is uncertain.

## Extension boundary

These five bundled plugins plus remote MCP servers are the supported
integrations. Arbitrary plugin installation, custom endpoints, and multiple
accounts per plugin are not available yet. See
[ADR 004](decisions/004-wisp-plugins.md) for the connection model, adapter
boundaries, and validation scope.
