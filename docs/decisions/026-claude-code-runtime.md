# ADR 026: Claude Code as a Wisp runtime

- Status: Accepted
- Date: 2026-10-19
- Decision owners: Wisp product, backend and security boundary
- Scope: Running a Wisp on the person's Claude subscription through the
  official Claude Code binary
- Related: [ADR 001](001-agent-runtime.md), [ADR 017](017-container-execution.md),
  [ADR 019](019-scheduled-jobs.md), [ADR 021](021-fallback-models.md),
  [ADR 023](023-wisp-permissions.md), [ADR 025](025-provider-subscription-sign-in.md),
  SWE-148, SWE-182, SWE-184

## Context

[ADR 025](025-provider-subscription-sign-in.md) left Claude subscriptions out:
Pi's Claude sign-in poses as Claude Code, and Anthropic's
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page does not allow third-party apps to offer Claude.ai sign-in, route requests
through Free, Pro, or Max credentials, or collect or store those tokens.

The same page allows the other direction. A product may run Claude Code when
the binary is unmodified, none of its sign-in methods are removed, nothing
resells or intermediates usage, and each end user signs in with their own
credentials. It also does not prevent an end user from signing in to the
unmodified binary with their own subscription, including when a platform hosts
Claude Code.

Wisp is for personal use only. Each person runs it for themselves, never
commercially, as a different interface to Claude.

## Terms

Running the person's own Wisps on the unmodified binary, signed in by that
person through Anthropic's flow, fits the allowance above. Wisp never offers
Claude.ai sign-in, never reads, stores, or forwards the token, and every
request counts against the plan of the person who signed in.

Pro and Max limits assume "ordinary, individual usage". Scheduled jobs are
usually a single prompt, such as a web search or reading results from an MCP
server, which is ordinary use. Wisp shows the plan's usage rather than
limiting jobs.

Anthropic may enforce its terms without notice. If the binary or the policy
changes, a Claude Code Wisp stops answering and can switch to a Pi model.

## Prior art: T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) (`apps/server`, read at
`92a6b43`) runs Claude Code for the same reason. It is a coding interface on
the person's own machine, so it takes Claude Code's full tool preset (Bash
included) and the person's settings, hooks, and `CLAUDE.md`. Wisp confines
its agents instead. These parts of T3's design carry over:

- **The Claude Agent SDK**, not the CLI: one long-lived process per thread
  fed from a prompt queue; `interrupt()`, `setModel()`, and
  `setPermissionMode()` on the control channel; and `canUseTool` for
  approvals.
- **The person's own binary** (`pathToClaudeCodeExecutable`). Claude Code's
  platform binaries are not bundled: T3's installed app (433 MB here) has
  none, and the SDK's JavaScript is about 5 MB.
- **MCP credentials go over the control channel**, never in argv or files.
- **A long tool timeout**: Claude Code ends an HTTP MCP call after 60 seconds
  unless the server config sets `timeout`.
- **Plan usage** from `rate_limit_event`, including overage and per-window
  resets.

## What the spike verified

These ran against Claude Code 2.1.303, the Agent SDK 0.3.276, and a Pro plan,
with `haiku`, in fresh temporary directories, on 2026-10-19.
`scripts/claude-code-smoke.mjs` repeats them; all 12 passed. Tests never
start the real binary.

| Behavior | Result |
| - | - |
| SDK with `pathToClaudeCodeExecutable` set to the person's `claude`, `extraArgs: { restricted: null }`, `settingSources: []`, a clean `env` | Signs in with the plan (`apiKeySource: "none"`). `--bare` cannot be used: it reads only API keys. |
| `tools: []`, an in-process `sdk` MCP server, `strictMcpConfig: true`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` | Only Wisp's tools are offered. Without the last two, the person's claude.ai connectors (from their account) were offered too. |
| In-process MCP tools described with plain JSON Schema (`McpServer.server` request handlers) | Work; zod is not needed. |
| `allowedTools: ["mcp__wisp__*"]` | Wisp's tools run without `canUseTool`. |
| `tools: ["WebSearch"]` | WebSearch runs; its prompt reaches `canUseTool` as `WebSearch` with `{ query, mode }`. |
| Hooks in the workspace's `.claude/settings.json` | Not run (`settingSources: []`, `settings: { disableAllHooks: true }`, `--restricted`). |
| `systemPrompt: { type: "preset", preset: "claude_code", append }` | Applied: the Wisp answered with its soul's name. |
| `extraArgs: { "system-prompt-snapshot": "off" }`, then `resume` with a different `append` | The resumed session follows the new prompt (it answered with the new name). |
| Several turns on one query | The same process and session keep the conversation. |
| A follow-up sent with `priority: "next"` during a turn | Steers it: the turn made 1 of 3 planned calls, then did what the follow-up asked. Without it, the follow-up waits for the next turn. |
| The follow-up's `uuid` | A `command_lifecycle` message with `state: "started"` and that `command_uuid` when the turn reads it, and the reply after it carries it as `user_message_uuid`. |
| `cancelAsyncMessage(uuid)` on a queued message (in the SDK, not its types) | Resolves `true`, and the message never runs. |
| An image block in a user message | Reaches the model. |
| `interrupt()` during a reply | The turn ends with `error_during_execution`; the same process takes the next message. |
| `resume` of a session that no longer exists | An error result (`error_during_execution`). |
| An in-process MCP tool that takes 75 s | Completes. |
| CLI only: `claude -p --restricted` with a Read outside the working directory | Refused by the Read tool (file tools stay confined). |
| CLI only: `claude auth status --json` | `loggedIn`, `authMethod`, `subscriptionType`, without the token. It also returns the account's email, which Wisp drops. |

## Decision

**A Wisp can run on Claude Code instead of Pi. For each conversation, Wisp
runs the person's unmodified `claude` through the Claude Agent SDK, signed
in as that person. The binary offers only Wisp's own tools, so the Wisp keeps
every boundary it has on Pi.**

### Where it plugs in

- A virtual provider, `claude-code` ("Runs on Claude Code with your Claude
  plan"), lists Claude Code's model aliases in the global and per-Wisp model
  pickers ([SWE-96](../models.md)):
  - `default`, `opus`, `sonnet`, and `haiku` are offered. Claude Code resolves
    them to the newest version (Opus 5.5, Sonnet 5.5, and Haiku 5.5 today,
    with `default` on Opus 5.5 for Pro and Max), so updating Claude Code moves
    the Wisp along without a Wisp change. The model each one resolved to,
    from the `init` message, is shown in the conversation.
  - `fable` and `best` are left out because Fable can bill usage credits
    instead of the plan.
  - `opusplan` and the `[1m]` variants are left out because Wisps have no plan
    mode and current models already have a 1M window.
  - Claude Code reports no context window or output limit for an alias, so
    those fields stay empty for this provider; Claude Code manages both
    itself.
- The conversation agent stays the same for every Wisp
  (`WispConversationAgent`, `backend/wisp-conversation-agent.ts`). It works
  through a runtime session (`RuntimeSession`, `backend/runtime-session.ts`):
  `prompt`, `steer`, `abort`, `setModel`, and Pi's agent events.
  `ClaudeCodeSession` (`backend/claude-code/claude-code-session.ts`) is such a
  session, as Pi's is (`backend/pi-session-factory.ts`), and a routing session
  factory gives it to Wisps on `claude-code`. Follow-ups, cancellation, model
  changes, and the event translator are shared rather than written again.
- What a Wisp's session runs with, its system prompt, skills, memory, and
  tools, comes from one builder (`WispSessionBuilder`,
  `backend/wisp-session-plan.ts`) for both runtimes.
- `@anthropic-ai/claude-agent-sdk` becomes a dependency, without its optional
  platform binaries. Its peers are already in Wisp: `@anthropic-ai/sdk`,
  `@modelcontextprotocol/sdk` 1.x, and `zod` 4, through Pi and the MCP client.
- Settings show whether `claude` is installed and signed in, and which plan,
  from `claude --version` and `claude auth status --json`.

### Claude Code versions

The SDK and the person's `claude` are released separately. T3 Code checks
only the CLI: it runs `claude --version`, hides models whose manifest entry
needs a newer CLI, and relies on newer CLIs accepting an older SDK. The SDK
itself checks nothing; its `package.json` names the CLI it was built with
(`claudeCodeVersion`, 2.1.276 for SDK 0.3.276). Wisp does this:

- **Binary:** the `claude` on the server's `PATH`. Wisp never bundles one.
- **Minimum:** the `claudeCodeVersion` of the SDK Wisp ships, read from the
  SDK's `package.json`. It is above the 2.1.248 that `--restricted` needs.
  An older `claude`, or none, makes the provider unavailable, and settings say
  to install it or run `claude update`. Newer versions are accepted.
- **Features, not versions:** the `capabilities` that `system/init` reports
  (such as `interrupt_receipt_v1`) decide whether an optional feature is used;
  without one, the conversation goes on without it.
- **No per-model minimum:** Wisp offers aliases, which the installed CLI
  resolves to the newest model it knows.
- **SDK updates:** a Wisp release that updates the SDK runs the smoke script
  against the current `claude` first.

### One process per conversation

`backend/claude-code/claude-code-launch.ts` builds the query options:

- `cwd` is the conversation's workspace.
- `pathToClaudeCodeExecutable` is the person's `claude`, found on the server's
  `PATH`.
- `env` carries only `HOME`, `PATH`, locale, time zone, `TMPDIR`,
  `CLAUDE_CODE_OAUTH_TOKEN` when the person set one, and
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`. An `ANTHROPIC_API_KEY` would win over
  the sign-in, and the Wisp server's own variables stay out.
- `settingSources: []`, `strictMcpConfig: true`,
  `extraArgs: { restricted: null, "system-prompt-snapshot": "off" }`,
  `settings: { disableAllHooks: true }`, `permissionMode: "default"`.
- `tools: []` (or `["WebSearch"]`), `allowedTools: ["mcp__wisp__*"]`, the
  in-process `wisp` server with a 65-minute `timeout`, and `canUseTool`.
- `systemPrompt` is Claude Code's preset with the Wisp's soul, the person's
  profile, the time, and the app's context appended.
- `sessionId` for a new conversation, `resume` after a restart.

The prompt stream lives as long as the conversation is active:

- **Messages:** each message, with its images, goes into the prompt stream.
  One sent while a turn runs goes with `priority: "next"` and a `uuid`, and
  steers it, as Pi's steering does.
  - When Claude Code reports it read the follow-up, the session emits a user
    `message_start`, from which the conversation agent emits
    `follow_up_taken`, as with Pi.
  - At the turn's result, follow-ups it did not read are withdrawn with
    `cancelAsyncMessage`, so Claude Code does not answer them with a turn of
    its own; the conversation agent sends them as messages of their own. One
    Claude Code already started reading cannot be withdrawn, and the turn
    goes on to answer it.
- **Stop:** calls `interrupt()`, and the reply is marked cancelled.
- **Deadline:** the 10-minute request deadline ([ADR 001](001-agent-runtime.md))
  applies to each turn.
- **Idle:** after 30 minutes without a message, the process closes, and the
  next message resumes the session.
- **Model, reasoning, or identity change:** the idle process closes, and the
  next message resumes the session in a new process with the new options.
  Claude Code records the system prompt for a conversation unless
  `system-prompt-snapshot` is off, so with it off a changed soul applies
  without starting a new Claude Code session.
- **Events:** `backend/claude-code/claude-code-events.ts` turns the SDK's
  messages into Pi's agent events, which the shared translator turns into
  Wisp's.

### Wisp's tools in-process

Wisp's tools are already provider-neutral definitions (name, description,
JSON schema, `execute`), and they authorize themselves inside `execute`
through the `ToolAuthorizationBroker`. The same definitions a Pi Wisp gets are
offered from an in-process MCP server, registered with JSON Schema on the
MCP server's request handlers:

- the confined file tools (`read` with document reading, `grep`, `find`,
  `ls`, `edit`, `write`);
- `run_command` and `process` in the Wisp's container
  ([ADR 017](017-container-execution.md));
- skills, jobs, Wisp management, plugins, and the MCP servers the Wisp has
  access to.

There is no HTTP server, port, token, or config file. Approval cards, lasting
rules ([ADR 023](023-wisp-permissions.md)), the tool audit, and the boundary
that commands never run on the server stay exactly as they are. Defining
Wisp's tools with zod is a separate improvement (SWE-184); this design does
not need it.

Claude Code's own tools are left out for the boundary and for consistency;
the terms allow them:

| Claude Code tool | Decision |
| - | - |
| Bash, PowerShell, and the other code-running tools | Out. They run on the server, which [ADR 017](017-container-execution.md) forbids; `run_command` runs in the container instead. |
| WebFetch | Out. It fetches from the server, so it could reach the local network that the egress proxy blocks for Wisps. |
| Read, Write, Edit, Glob, Grep | Out for now. They would work (confined by `--restricted`, approved through `canUseTool`), but Wisp's own read documents and images, follow lasting rules and audit categories, and respect the workspace size. Worth trying later if Claude edits better with its own Edit. |
| WebSearch | **In**, as a web search provider for the Wisp, "Claude (included in your plan)", next to the search plugins. It runs on Anthropic's side and counts against the plan, so it needs no key. It follows the same rules as `web_search`. |

How WebSearch is offered:

- The Wisp's search provider is saved as `claude-code` with its other
  provider choices, without a plugin grant. The Access tab lists it while the
  Wisp runs on Claude Code; on Pi the choice stays saved, and the Wisp has no
  web search.
- A Claude Code session lists it as the Wisp's `web_search`, so a job can
  name it, and a run offers it only when the job does, as on Pi.
- Like a plugin's `web_search`, it runs without asking. `canUseTool` allows
  WebSearch while it is still the Wisp's choice and denies anything else that
  would prompt. Choosing it changes the integration snapshot's revision, so
  the session restarts with it.
- Its events carry the name `web_search`, so the activity reads as a search.

### Sessions

- Claude Code keeps its transcript in `~/.claude/projects/` on the server's
  computer, in plaintext, and deletes it after 30 days unused
  (`cleanupPeriodDays`).
- The Wisp's own transcript in its store stays the record the person sees,
  searches, and backs up.
- When `resume` fails because the session no longer exists, the
  conversation starts a new Claude Code session, and the appended prompt
  carries the latest Wisp messages as context.
- Deleting a Wisp or conversation runs `claude purge <workspace>`.
- Moving Claude Code's data with `CLAUDE_CONFIG_DIR` would also move the
  sign-in into Wisp's data and backups, so Wisp does not do it.

### Sign-in

- **Desktop:** the person runs `claude auth login` in a terminal.
- **Headless server:** `claude auth login` over SSH, pasting the code the
  browser shows, or `claude setup-token` with `CLAUDE_CODE_OAUTH_TOKEN` in the
  server's service environment.
- **Expired sign-in:** an expired or missing sign-in becomes a
  `configuration_required` error that names the command to run.

### Usage

- Each turn's model and token usage go to `claude-code-usage.jsonl` in the
  Wisp's session folder, as entries shaped like Pi's, so the session report
  and Token usage read it as they read Pi's sessions. It holds no messages.
- A turn on a plan is marked `billing: "plan"`. It costs nothing more and
  shows a **Claude plan** badge. On an API account, the turn's cost is what it
  added to Claude Code's estimate, which adds up over a process's turns.
- The session report shows the usage log while it is newer than the Wisp's
  Pi session, with the fallback model's turns, each kept in a folder of its
  own under `claude-code-fallback/`.
- The plan's 5-hour and weekly usage, from `rate_limit_event` (verified:
  `rate_limit_info.unifiedWindows.five_hour` and `seven_day`, each with
  `utilization` and `resetsAt`), shows in Claude Code's status in Settings
  once a window is three-quarters used, or a limit was reached.

### What a Claude Code Wisp does differently

- **Scheduled jobs** ([ADR 019](019-scheduled-jobs.md)): a run is a one-turn
  query with `persistSession: false`, offered the job's tools from the
  in-process server, as a Pi run is.
- **Fallback** ([ADR 021](021-fallback-models.md)): when Claude Code fails
  for good (signed out, plan limit reached), the turn moves to the Wisp's Pi
  fallback model, if it has one.
  - The fallback runs in a Pi session of its own, kept apart from the Wisp's
    Pi session, and is closed after the turn; the next message tries Claude
    Code again.
  - It has none of Claude Code's history, so it is told the latest messages
    of the Wisp's transcript, as when a lost session is replaced.
  - Other failures, such as an overloaded API or a crashed process, fail the
    turn, which can be sent again.
- **Context** ([context and memory](../context-and-memory.md)): the Context
  tab works as on Pi, with the same policy and memory file.
  - **Compact** sends `/compact`, which Claude Code runs through the SDK like
    its own command (verified: the conversation continued with what was said
    before).
  - **New topic** starts a new Claude Code session.
  - Automatic renewal follows the Wisp's policy before a message, from the
    last activity and the context size Claude Code reported, which are kept
    with the session.
  - Claude Code keeps its own summary, so none is shown.
  - `search_history` reads the Wisp's own transcript.

### Why the SDK, not the CLI or ACP

The spike first drove `claude -p` directly, and every check passed there too.
The SDK runs the same binary, and the docs call `claude -p` the Agent SDK's
CLI, so the terms treat both the same. The SDK is Anthropic's own package and
replaces four pieces Wisp would otherwise build:

- a loopback HTTP MCP server with a bearer token in a config file;
- a permission-prompt MCP tool;
- the stream-json control protocol (interrupt, model changes);
- a process per turn, which could not steer.

Zed's ACP adapter is built on this SDK, adds a dependency between Wisp and it,
and hides the options this design needs. ACP is worth reconsidering when a
second external agent, such as Codex, needs the same integration.

## Consequences

- A Wisp can run on a Claude plan without an API key, keeping its tools,
  approvals, container, audit, and steering.
- Of Claude Code's own tools only WebSearch is used; the model works with
  Wisp's tools otherwise.
- Claude Code's transcripts live on the server's computer outside Wisp's data,
  like the person's own Claude Code sessions.
- Wisp depends on the person's Claude Code being at least the version the
  shipped SDK was built with. The smoke script is the check after an update.
