# ADR 023: What a Wisp may do without asking

- Status: Accepted
- Date: 2026-10-15
- Decision owners: Wisp backend and security boundary
- Scope: Lasting approvals, per-Wisp permissions, risk mode, and how long a
  card waits
- Related: [ADR 016](016-mcp-file-arguments.md),
  [ADR 017](017-container-execution.md), [ADR 019](019-scheduled-jobs.md),
  [security](../security.md), SWE-157

## Context

Most actions that change something ask first. Only some cards offered a lasting
answer: workspace files (only while auto-review was on, saved for every Wisp)
and a single MCP tool. Linear writes and whole MCP servers had none, so the
same card came back on every call.

A card also expired after 60 seconds, and the time it waited counted toward
the 10-minute deadline of the request. Leaving the conversation for a minute
was enough for an action to be denied, so the person had to watch every
conversation that might ask, even for short tasks.

## Decision

**Nothing has to be approved twice, and a card waits for the person.**

- **Workspace files, per Wisp.** Allow, Ask or Block for **Create files** and
  **Edit files**, set in the Wisp's **Access** tab or with **Always allow** /
  **Always block** on a card, with or without auto-review. A category the Wisp
  sets nothing for follows the app-wide setting in **Settings → General →
  Auto-review**, which stays the default.
- **Plugins.** A Linear write card offers **Always allow this tool** and
  **Always allow all of Linear**, for this Wisp. The Access tab adds **Write
  without asking** next to **Read and write**, lists the always-allowed tools,
  and can remove them; a form never adds a single tool.
- **MCP servers.** A third access level, **Use without asking**
  (`allow_all`), next to **Use with approval**. It covers every tool of the
  server, including tools the server adds or changes later. A card offers it
  as **Always allow all of {server}**. A call that sends workspace files still
  asks ([ADR 016](016-mcp-file-arguments.md)).
- **Risk mode.** **Allow everything** in the Access tab lets the Wisp create
  and edit files, write to plugins and call MCP tools, file-sending calls
  included, without asking. It does not cover skills, jobs or commands outside
  a container: skills become standing instructions and jobs grant tools to
  unattended runs, so the person reviews each one.
- **Blocks still win.** An app-wide Block rule is checked first and nothing
  above overrides it. A Wisp's own Block for a kind of file change also wins
  over risk mode.
- **Cards wait.** A card waits 30 minutes instead of 60 seconds, and the
  request deadline is paused while any card of that conversation waits, so
  answering late does not time the reply out.
- **Audit.** Actions allowed by risk mode are logged as `allow_everything`;
  those allowed by a remembered tool or integration as `allow_always`.

### Where it is stored

Each permission is kept by the service that enforces it, as before; nothing
moves to the database.

- MCP: `mcp-servers.json`. `grants[session][server]` accepts `allow_all`;
  always-allowed tools stay in `alwaysAllowed`, bound to their definition.
- Plugins: `plugins.json` gains `alwaysAllowed[session][plugin]`, either
  `"all"` or a list of write tools. It is dropped when the Wisp loses write
  access or the plugin's key is removed or replaced.
- Files and risk mode: `tool-policy.json` in the Wisp's config folder, next to
  its execution and workspace settings, so it goes with the Wisp when it is
  deleted and the Wisp's own tools cannot reach it. A missing or damaged file
  means the Wisp has no permissions of its own. The broker reads it through an
  in-memory cache, so an approval card is still published in the same tick as
  its action.

## Consequences

- A person who trusts a Wisp answers each kind of card once, or turns on risk
  mode, and the Wisp works without them.
- **Accepted risk:** with risk mode, or **Use without asking** on a server, a
  Wisp misled by content it read can change connected services and send
  workspace files to MCP servers without anyone seeing a card. The toggle says
  so, and every such action is in the audit log.
- File rules are no longer app-wide when set from a card: **Always allow** on
  one Wisp's card does not allow another Wisp.
- A pending card holds the conversation's turn, and one of the four agent
  slots, for up to 30 minutes.

## Rejected alternatives

- **A new table for permissions:** the services that enforce them already own
  their state and its pruning (revoked grants, changed tools, removed
  servers). Moving it would split validation from enforcement.
- **Risk mode as a shortcut that switches every level on:** a flag also covers
  integrations granted later, and turning it off returns the Wisp to exactly
  what it had.
- **Risk mode covering skills and jobs:** both outlive the conversation and
  widen what the Wisp may do later; they keep their own review.
- **Cards that never expire:** an abandoned card would hold the turn forever.
