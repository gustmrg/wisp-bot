# Bundled plugins

Wisp ships with bundled integrations: **Brave Search** (web search),
**Linear**, **Firecrawl**, **Tavily**, **Exa**, and **DeepSeek** (the latter
four support web search and page reading), **Google Calendar**, **Gmail**, and **Google
Drive**, which sign in with your own Google OAuth client, and **Home
Assistant**, which connects to your own server. Connections are configured globally in
**Settings → Plugins**; each Wisp receives access independently through its
**Access** tab. Connecting a plugin grants no Wisp access automatically.

**GitHub**, **GitLab**, and **Atlassian** (Jira and Confluence) are also
listed under Plugins but run over a remote MCP connection; see
[GitHub](#github), [GitLab](#gitlab), and [Atlassian](#atlassian). Plugins of this kind that sign in through the browser
have no form: **Connect** opens the provider's page to approve access, and
**Sign in again** on the plugin's page repeats it. For dynamically discovered
integrations, see [remote MCP servers](mcp-servers.md).

## Connecting a plugin

Open **Settings → Plugins**. Connected plugins are listed first, with an
**Enabled** switch and the number of Wisps that can use them; the rest are
listed under **Available** with what they provide (search, page reading, or
their category). Select a plugin, enter its **Brave Search API key**, **Linear
personal API key**, **Firecrawl API key**, **Tavily API key**, **Exa API
key**, or **DeepSeek API key** (each form links to the provider page that issues it), and select
**Connect**. Connecting tests the key first and saves it only if the test
succeeds. Each plugin supports one connection on this device.

**Home Assistant** also asks for the address of your server with its
**long-lived access token**. Both are tested and saved together, and replacing
the key asks for the address again, prefilled. See
[Home Assistant](#home-assistant).

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
- DeepSeek testing performs one search with one result; a search that returns
  results is billed.

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

A Wisp on [Claude Code](models.md#claude-code) can also choose **Claude
(included in your plan)** for **Search the web**: Claude Code's own web
search, which runs on Anthropic's side within the Claude plan and needs no
plugin or key. It searches only while the Wisp runs on Claude Code; on another
model the choice stays saved, and the Wisp has no web search.

## Capabilities

| Plugin | Category | Access levels | Tools |
| --- | --- | --- | --- |
| Brave Search | Web & research | `none`, `read` | `web_search` |
| Linear | Productivity | `none`, `read`, `write` | `linear_search_issues`, `linear_get_issue`, `linear_list_comments`, `linear_list_teams`, `linear_list_statuses`, `linear_list_projects`, `linear_list_labels`, `linear_list_users`; write also enables `linear_create_issue`, `linear_update_issue`, and `linear_add_comment` |
| Firecrawl | Web & research | `none`, `read` | `web_search`, `web_read` |
| Tavily | Web & research | `none`, `read` | `web_search`, `web_read` |
| Exa | Web & research | `none`, `read` | `web_search`, `web_read` |
| DeepSeek | Web & research | `none`, `read` | `web_search`, `web_read` |
| Google Calendar | Productivity | `none`, `read`, `write` | `google_calendar_list_calendars`, `google_calendar_list_events`, `google_calendar_get_event`, `google_calendar_free_busy`; write also enables `google_calendar_create_event`, `google_calendar_update_event`, and `google_calendar_respond_to_event` |
| Gmail | Productivity | `none`, `read`, `write` | `gmail_search_messages`, `gmail_read_message`, `gmail_read_thread`, `gmail_list_labels`, `gmail_list_drafts`; write also enables `gmail_create_draft` and `gmail_update_draft` |
| Google Drive | Productivity | `none`, `read`, `write` | `google_drive_search_files`, `google_drive_get_file`, `google_drive_read_file`; write also enables `google_drive_create_file`, `google_drive_create_folder`, and `google_drive_update_file` |
| Home Assistant | Smart home | `none`, `read`, `write` | `home_assistant_list_entities`, `home_assistant_get_state`, `home_assistant_get_history`; write also enables `home_assistant_control`, `home_assistant_control_secure`, `home_assistant_run_scene`, and `home_assistant_run_script` |

GitHub, GitLab, and Atlassian are not in this table: their tools are
discovered from their MCP servers, and their access levels are those of
[remote MCP servers](mcp-servers.md#per-wisp-access).

## Shared web tools

Web capabilities are independent of the selected LLM provider. Wisps use two
provider-independent tools backed by their connected, enabled, and granted plugins:

- `web_search({ query, count? })` finds sources and returns `provider`, `query`,
  `results` (titles, URLs, snippets), and `moreResultsAvailable`. Queries are
  limited to 500 characters and 75 words; `count` is 1–10 (default 5).
  Search uses the provider chosen for that Wisp. Firecrawl,
  Tavily, Exa, and DeepSeek report `moreResultsAvailable` as `null` because their APIs
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
Search → Firecrawl → Tavily → Exa → DeepSeek) until their access is saved again. Updating
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

DeepSeek-backed `web_search` uses the
[Search API](https://api-docs.deepseek.com/guides/search/) and returns its
model-oriented summary as the snippet, falling back to the short snippet. The
API accepts queries of at most 128 characters, so longer queries are rejected
before any request with a message asking for a shorter one. `web_read` uses the
Fetch API, which returns the page as Markdown; pages DeepSeek's security policy
blocks fail with HTTP 403. Each successful search or fetch is billed per
request, and an account without balance fails with HTTP 402.

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

## GitLab

**Settings → Plugins → GitLab** connects
[GitLab's official MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)
on GitLab.com or on your own GitLab Self-Managed or Dedicated instance. The
**GitLab address** starts as `https://gitlab.com`; for your own instance,
enter its address (with the path it is served under, if any), and the
connection uses `/api/v4/mcp` on it. The server needs GitLab 18.6 or later, and
the top-level group's owner (on GitLab.com) or the instance's administrator
must allow access to it. One GitLab connection is offered at a time; entering
another address later removes every Wisp's access to it, as a new token would.

Enter a fine-grained personal access token with the **Execute** permission on
the MCP server; **Create a token** opens the token page of the instance you
entered. GitLab refuses legacy personal access tokens and project or group
access tokens. The token is sent as `Authorization: Bearer …`. Core,
Repository, Merge requests, Work items, and CI/CD are selected by default, and
Wikis and Code security can be added; the selection is sent as
`X-Gitlab-Enabled-Mcp-Server-Toolsets`, which instances before GitLab 19.5
ignore. Access, approvals, and the **Enabled** switch work as for GitHub.

Wisps with access also see a **gitlab** skill: identify projects by their full
path with subgroups, call pull requests merge requests (`!123`), never merge,
approve, or run pipelines unless asked, and make code changes in the Wisp's
container when it can run commands.

In a Wisp's container, git over HTTPS to the instance goes through the same
gateway as github.com, which adds the GitLab token, so the Wisp can clone and
push the private projects the token covers without seeing it. The token needs
access to the repositories as well as the MCP server. An instance on your local
network is reached this way even when the Wisp's local network is blocked, for
git only. Instances whose certificate is not signed by a public certificate
authority are not supported yet.

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
   **Google Calendar API** for Google Calendar, **Gmail API** for Gmail,
   **Google Drive API** for Google Drive.
3. Under **Google Auth Platform**, configure the consent screen: an app name
   and your email under **Branding**, then the user type under **Audience**:
   **External** for a personal Gmail account, or **Internal** for a Google
   Workspace organization.
4. Under **Data access**, add the plugins' scopes. Google Calendar uses
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/calendar.calendarlist.readonly`; Gmail uses
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.compose`; Google Drive uses
   `https://www.googleapis.com/auth/drive.readonly` and
   `https://www.googleapis.com/auth/drive.file`. Google lists the Gmail and
   `drive.readonly` scopes as restricted, which matters only for apps published
   to others.
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

## Gmail

With **Read only**, a Wisp can search your mail with Gmail's search syntax
(`gmail_search_messages`, for example `from:ana@example.com newer_than:7d`),
read a message or a whole thread as text (`gmail_read_message`,
`gmail_read_thread`; HTML mail is converted to text, and attachments are listed
by name but never read), and list your labels and drafts
(`gmail_list_labels`, `gmail_list_drafts`).

With **Read and write**, it can write drafts: a new email or a reply that joins
the original thread and goes to its sender (`gmail_create_draft`), and rewrite
a draft (`gmail_update_draft`). Each draft asks for approval unless you allowed
it without asking.

**Wisps never send email.** The plugin has no tool that sends, so you review
every draft in Gmail and send it yourself. Google has no scope that allows
writing drafts without also allowing sending, so `gmail.compose` is requested;
the limit is in Wisp, not in Google's permission. The plugin cannot delete
mail, change labels, or read attachments. Email contents are written by other
people and reach the Wisp as data, not instructions.

## Google Drive

With **Read only**, a Wisp can search your Drive, including shared drives and
files shared with you, by words in the name or content, type, folder, or
modification date, and list a folder (`google_drive_search_files`); read a
file's details (`google_drive_get_file`); and read a file as text
(`google_drive_read_file`). Google Docs and Slides are read as plain text, a
Google Sheet as CSV of its first sheet, and text files such as `.txt`, `.md`,
`.csv`, or `.json` directly; long files are truncated. PDFs, images, and other
files are not read, only described.

With **Read and write**, it can create files: a Google Doc from plain text, a
Google Sheet from CSV, or a text file whose type follows its extension
(`google_drive_create_file`); create folders (`google_drive_create_folder`);
and rename or rewrite the files it created (`google_drive_update_file`). Each
change asks for approval unless you allowed it without asking.

**Wisps change only the files they create.** Writing uses the `drive.file`
scope, which Google limits to files and folders created with your OAuth
client, so a Wisp cannot edit, move, delete, or reshare your own files, even
with write access; it can add files only to My Drive or to folders it created.
Files created with one OAuth client cannot be changed after you switch to a
client from another Google Cloud project. File contents are written by other
people and reach the Wisp as data, not instructions.

## Home Assistant

Connect with your server's address and a long-lived access token. Create the
token in Home Assistant under your profile, on the **Security** tab, at the
bottom under **Long-lived access tokens**. Home Assistant tokens cannot be
limited: they can do anything their user can. Consider creating a dedicated
user for Wisp, and remember that a Wisp with write access can control every
device that user can.

The address may use HTTPS anywhere, such as through Home Assistant Cloud or a
reverse proxy, or plain HTTP on your local network or tailnet:
`http://homeassistant.local:8123`, a private IP address such as
`192.168.1.10`, a Tailscale address or `*.ts.net` name, or a single-word host
name. HTTP to any other address is refused because the token would cross the
internet unencrypted. The address is checked from the computer that runs the
Wisp server, so with a [server on another computer](remote-server.md) it must
be reachable from there.

With **Read only**, a Wisp can list devices, sensors, scenes, and scripts with
their state and area (`home_assistant_list_entities`), filtered by domain such
as `light`, area such as `Kitchen`, or words in the name; read one entity's
state and attributes (`home_assistant_get_state`); and see how it changed over
the last hours, up to a week (`home_assistant_get_history`).

Areas come from Home Assistant's template API, which may be limited to
administrators. When the token cannot use it, entities are listed without
their areas and filtering by area is unavailable; everything else works.

With **Read and write**, it can:

- control ordinary devices (`home_assistant_control`): turn lights, switches,
  fans, media players, climate, and humidifiers on or off, or toggle them; set
  a light's brightness, a thermostat's temperature, or a media player's
  volume; open, close, or stop blinds and shades;
- control what secures your home (`home_assistant_control_secure`): lock,
  unlock, or open locks, arm or disarm alarms, and open, close, or stop garage
  doors, gates, and doors. A lock or alarm code is sent only when you give it,
  and never appears on the approval card;
- activate scenes (`home_assistant_run_scene`) and run scripts
  (`home_assistant_run_script`).

Each action asks for approval unless you allowed it without asking. Because
**Always allow this action** is remembered per tool, allowing lights does not
allow locks, alarms, or doors. **Always allow all** of the plugin's actions
covers them too. The plugin calls only these actions: it cannot restart Home
Assistant, change its configuration, or call other services. Scripts can do
anything they were written to do, so allow them with care. Names, states, and
attributes come from devices and integrations and reach the Wisp as data, not
instructions.

## Revocation and key changes

Disabling a plugin blocks all Wisps but retains their grants. Replacing a key
with a different key, or a Home Assistant address with a different one, or
removing its connection clears every Wisp's grants for that plugin. Revocation blocks new calls and cancels pending
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
