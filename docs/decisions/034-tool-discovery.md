# ADR 034: Integration tools loaded when needed

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp maintainer, backend
- Scope: Which plugin and MCP tools a Wisp's model sees in each request, and
  how it reaches the others
- Related: [ADR 001](001-agent-runtime.md), [ADR 004](004-wisp-plugins.md),
  [ADR 005](005-remote-mcp-servers.md), [ADR 019](019-scheduled-jobs.md),
  [ADR 026](026-claude-code-runtime.md), SWE-235

## Context

Every request a Wisp makes carries the name, description, and parameter
schema of every tool it is offered. The bundled plugins other than web search
have 38 tools and 30,788 characters of schema, about 7,700 tokens; an MCP
server such as GitHub's has dozens more. Each request pays for them, and some
models refuse a request with that many tools: Wisp already has a message for
that refusal (`TOO_MANY_TOOLS_PATTERN` in `backend/provider-error.ts`).

OpenBot measured the same problem and keeps ten tools declared, with three
discovery tools for the rest, which cut its fixed request text by 80%. Pi
itself now offers this: a tool with `deferred` exposure is not declared to
the model, and Pi's `tool_search` tool finds such tools with BM25 over their
names, descriptions, schemas, and namespaces, and activates the matches for
the next model call. The model then calls the tool itself, so the tool runs
through its own definition: the same approvals, audit, and display.

## Decision

**A Wisp on Pi with more than 12 granted plugin and MCP tools declares none
of them; it loads the ones it needs with Pi's `tool_search`.**

- `deferIntegrationTools` (`backend/tool-discovery.ts`) chooses them from the
  snapshot's metadata: tools with a `group`, which plugin and MCP tools now
  carry (the plugin's or the server's name), that the Wisp is granted, except
  the shared web tools. Up to `MAX_DECLARED_INTEGRATION_TOOLS` (12), nothing
  changes. Above it, all of them are deferred, so the set does not depend on
  which tools happen to be used.
- `WispSessionBuilder.plan` decides it once per session, and only when the
  runtime asks (`deferTools`), which Pi's factory does and Claude Code's does
  not. A job run defers nothing: it offers only the tools approved with its
  job.
- Deferred definitions get `exposure: "deferred"` and a namespace named after
  their integration, so a search for "Linear" finds Linear's tools.
- The session loads Pi's `createToolSearchExtension()`. `tool_search` joins
  the registry and the allowed tools, but not `BUILTIN_TOOL_NAMES`, and job
  runs never offer it.
- The system prompt names each integration whose tools are deferred, with how
  many, and tells the Wisp to search with words for the action before saying
  it cannot do something. The section changes only when the session is
  rebuilt, so the prompt cache holds.

### What stays declared

- Before each message, Wisp declares the allowed tools as before, except
  deferred ones, which stay declared once `tool_search` loaded them and while
  they are still granted.
- Pi activates every tool it is given when a session starts, deferred ones
  included, so the active set cannot tell what was loaded. The factory records
  the names each successful `tool_search` result reports.
- A revoked grant removes a loaded tool at the next message, and the session
  is rebuilt as before. Plugin and MCP tools also check the grant when they
  run, so a tool cannot run without one.
- Loaded tools are not restored after a restart or a rebuild; the Wisp loads
  them again.

### Measured

For a Wisp with Linear, Google Calendar, Gmail, Google Drive, and Home
Assistant, the request no longer carries their 38 tools (30,788 characters).
It carries `tool_search` (615 characters) and the prompt section (553). The
net saving is 29,620 characters, about 7,400 tokens, on every request until
the Wisp loads a tool, and only that tool's schema after.

## Consequences

- Requests of Wisps with many integrations are smaller, and the refusal for
  too many tools no longer happens because of plugins or MCP servers.
- The first use of an integration's tool in a session takes one more model
  call, for `tool_search`.
- Loading a tool changes the declared tools once, which ends the prompt cache
  from that point; later requests cache again.
- Wisps with few integration tools, job runs, and Claude Code Wisps work as
  before.

## Deferred

- Claude Code Wisps. Claude Code has a tool search of its own for MCP tools,
  but Wisp offers it no built-in tools, and turning it on needs a check
  against the real binary, as ADR 026's smoke script does.
- A per-Wisp choice of which tools are always declared or never offered, for
  models with a small context window.
- Keeping loaded tools across restarts.

## Decisions taken with the user

- Implement after the custom endpoints stack, as the next issue of the plan
  (SWE-235).

## Rejected alternatives

- **Wisp's own `tool_search`, `tool_describe`, and `tool_call` tools, as in
  OpenBot.** `tool_call` would run another tool by name, so every place that
  shows or records a tool call would have to look inside it. Pi's search
  declares the real tool instead.
- **Deferring every integration tool.** One plugin of a few tools would cost
  a search for a small saving.
- **Deferring per integration, above a size each.** Several medium plugins
  would still fill each request.
- **Choosing deferred tools by the request.** It would change the declared
  tools on every turn, losing the prompt cache.
