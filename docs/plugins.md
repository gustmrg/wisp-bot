# Bundled plugins

Wisp ships with bundled integrations: **Brave Search** (web search),
**Linear**, **Firecrawl**, **Tavily**, and **Exa** (the latter three support web
search and page reading), and **Google Calendar**, which signs in with your
own Google OAuth client. Connections are configured globally in
**Settings → Plugins**; each Wisp receives access independently through its
**Access** tab. Connecting a plugin grants no Wisp access automatically.

**GitHub** and **Atlassian** (Jira and Confluence) are also listed under
Plugins but run over a remote MCP connection; see [GitHub](#github) and
[Atlassian](#atlassian). Plugins of this kind that sign in through the browser
have no form: **Connect** opens the provider's page to approve access, and
**Sign in again** on the plugin's page repeats it. For dynamically discovered
integrations, see [remote MCP servers](mcp-servers.md).

## Connecting a plugin

Open **Settings → Plugins**. Connected plugins are listed first, with an
**Enabled** switch and the number of Wisps that can use them; the rest are
listed under **Available** with what they provide (search, page reading, or
their category). Select a plugin, enter its **Brave Search API key**, **Linear
personal API key**, **Firecrawl API key**, **Tavily API key**, or **Exa API
key** (each form links to the provider page that issues it), and select
**Connect**. Connecting tests the key first and saves it only if the test
succeeds. Each plugin supports one connection on this device.

Plugins that sign in through the browser ask instead for an **OAuth client**
you create with the provider (each form links to its setup guide): enter its
client ID and secret and select **Connect**. The browser opens the provider's
page to approve access; with a server on another computer the desktop app
opens it and passes the result back, and in the browser app you paste back the
address the browser lands on. The plugin's page then shows the account, **Sign
in again** (also when its access expired or was revoked, which turns its tools
off until then), **Use another OAuth client**, which removes the plugin from
every Wisp, **Test connection**, and **Remove connection**.

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
its next message. Creating or updating Linear issues and adding comments
require an approval before execution, regardless of file auto-review rules.
The card offers **Always allow this tool** and **Always allow all of Linear**
for that Wisp; **Write without asking** in the Access tab does the same as the
second. The Access tab lists always-allowed tools and can remove them.

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

## GitHub

**Settings → Plugins → GitHub** connects
[GitHub's official MCP server](https://github.com/github/github-mcp-server)
(`https://api.githubcopilot.com/mcp/`) without filling in the endpoint or
headers. Enter a personal access token (a fine-grained token limited to the
repositories and permissions your Wisps need) and choose the toolsets:
Repositories, Issues, Pull requests, and Users are selected by default, and
Labels, Actions, Notifications, Discussions, Projects, Code scanning, and
Dependabot can be added. The token is sent as `Authorization: Bearer …` and
the toolsets as `X-MCP-Toolsets` (with `context` always included). Fewer
toolsets keep the Wisp's tool list short; GitHub's limit of tools per request
matters for some models. It does not need a browser sign-in, so it also works
with a [server on another computer](remote-server.md).

It is listed with the other plugins, with an **Enabled** switch and the
number of Wisps that can use it, and with the apps in each Wisp's **Access**
tab. Underneath it is an MCP connection, so access uses the MCP levels (**Use
with approval** or **Use without asking**) and approvals, and **Always allow
this tool** works as described in [remote MCP servers](mcp-servers.md).
Only one GitHub connection is offered. Organizations can restrict personal
access tokens, and on Copilot Business or Enterprise plans the "MCP servers in
Copilot" policy must be on.

Wisps with access to GitHub also see a **github** skill under their available
skills: instructions that come with the plugin, such as passing the repository
explicitly, searching with qualifiers, never merging or closing without being
asked, and making code changes in the Wisp's container when it can run
commands. It is not one of the Wisp's own skills: it is not
listed in its Skills settings, does not count toward its limit, and
disappears when the Wisp loses access. A skill of the Wisp's own with the same
name is used instead. Like every skill, it grants nothing.

## Atlassian

**Settings → Plugins → Atlassian → Connect** connects
[Atlassian's official MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/)
(`https://mcp.atlassian.com/v1/mcp`) for Jira and Confluence. There is nothing
to fill in: your browser opens Atlassian's sign-in, where you choose the site
to allow and approve access. Wisps then act as you, with your own Jira and
Confluence permissions; no API token or administrator is needed unless your
site's admins restrict which apps may connect.

With a [server on another computer](remote-server.md#oauth-sign-in-from-another-computer),
the desktop app opens the sign-in in its own browser and passes the result to
the server. In the browser app or on a phone, open the sign-in page from the
plugin and paste back the address the browser lands on.

Atlassian decides which tools the connection offers; Wisps see them all, so
choose **Use with approval** unless a Wisp should change issues and pages
without asking. If the sign-in expires or is revoked on Atlassian's side, the
plugin shows **Needs sign-in** until you sign in again.

Wisps with access also see an **atlassian** skill: find the site's cloud ID
first, search with JQL and CQL and small limits, look up issue types and
required fields before creating an issue, change status only through the
issue's transitions, and never delete or move issues unless asked. Like the
GitHub skill, it is not one of the Wisp's own skills and grants nothing.

## Setting up a Google OAuth client

Google's plugins sign in with an OAuth client from **your own** Google Cloud
project: Google does not let apps register themselves, and a client shipped
with Wisp would need Google's app verification. You do this once; the same
project and client can serve every Google plugin.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project, or choose one.
2. Under **APIs & Services → Library**, enable the API of each plugin you use:
   **Google Calendar API** for Google Calendar.
3. Under **Google Auth Platform**, configure the consent screen: an app name
   and your email under **Branding**, then the user type under **Audience**:
   **External** for a personal Gmail account, or **Internal** for a Google
   Workspace organization.
4. Under **Data access**, add the plugin's scopes. Google Calendar uses
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
5. For an **External** app, under **Audience**, select **Publish app** so its
   status is **In production**. While it is in **Testing**, Google ends the
   sign-in after 7 days and Wisp asks you to sign in again. For your own use the
   app does not need Google's verification: when you sign in, Google warns that
   it has not verified the app; continue through **Advanced**.
6. Under **Clients**, create a client of type **Desktop app**, and copy its
   **Client ID** and **Client secret**.
7. In Wisp, open **Settings → Plugins**, choose the plugin, paste the client ID
   and secret, and select **Connect**.

A Desktop app client accepts sign-in redirects to `http://127.0.0.1` on any
port, which is how Wisp receives them, also through the desktop app when the
server runs on [another computer](remote-server.md#oauth-sign-in-from-another-computer).
The client secret of a Desktop app is not confidential, but Wisp stores it
encrypted with the tokens anyway and never shows it to Wisps.

## Google Calendar

With **Read only**, a Wisp can list your calendars
(`google_calendar_list_calendars`), list and search events in a time range
with recurring events expanded (`google_calendar_list_events`), read one event
with its description, attendees, and meeting link
(`google_calendar_get_event`), and check busy times across up to 10 calendars
for up to 31 days (`google_calendar_free_busy`).

With **Read and write**, it can also create events
(`google_calendar_create_event`), change them
(`google_calendar_update_event`, only the fields given), and accept, decline,
or tentatively accept invitations (`google_calendar_respond_to_event`). Each
change asks for approval unless you allowed it without asking. Attendees and
organizers are emailed only when the Wisp is asked to (`notifyAttendees`,
`notifyOrganizer`); by default Google sends nothing.

The plugin cannot delete events or change calendar settings or sharing: its
scopes cover events and the calendar list only. Event descriptions are written
by other people and reach the Wisp as data, not instructions.

## Revocation and key changes

Disabling a plugin blocks all Wisps but retains their grants. Replacing a key
with a different key or removing its connection clears every Wisp's grants for
that plugin. Revocation blocks new calls and cancels pending
approvals/requests; it cannot undo a change already accepted by Linear. Check
Linear before retrying a write whose outcome is uncertain.

## Extension boundary

These bundled plugins plus remote MCP servers are the supported
integrations. Arbitrary plugin installation, custom endpoints, and multiple
accounts per plugin are not available yet. See
[ADR 004](decisions/004-wisp-plugins.md) for the connection model, adapter
boundaries, and validation scope. A possible direction for user-written,
installable plugins is described in the
[plugin extensibility analysis](plugin-extensibility-analysis.md).
