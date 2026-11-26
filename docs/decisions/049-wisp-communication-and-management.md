# ADR 049: Wisp communication and richer team management

- Status: Accepted
- Date: 2026-11-26
- Decision owners: Wisp product, backend, and security boundary
- Scope: Non-secret Wisp and circle inspection, extended Wisp editing, circle
  management tools, and direct Wisp-to-Wisp consultation (`ask_wisp`)
- Related: [ADR 011](011-circles.md), [ADR 023](023-wisp-permissions.md),
  [ADR 024](024-chief-and-wisp-tools.md), [ADR 026](026-claude-code-runtime.md),
  [security](../security.md)

## Context

[ADR 024](024-chief-and-wisp-tools.md) gave every Wisp basic tools to list,
create, update, and delete other Wisps (`list_wisps`, `create_wisp`,
`update_wisp`, `delete_wisp`) and introduced Chief as the team builder.

In practice, managing a multi-Wisp team hit three limits:

1. **Shallow visibility.** `list_wisps` showed only models, fallbacks, memory,
   and souls, leaving Chief unable to answer questions about appearance, circle
   memberships, skills, scheduled jobs, capabilities, workspace usage, or which
   integrations each Wisp has access to. There was no tool to inspect circles.
2. **Incomplete configuration.** Creating or updating a Wisp through chat could
   not set memory on/off, a per-Wisp model override, or a fallback model, and
   Wisps could not create or update circles.
3. **No direct consultation outside circles.** A Wisp working in its own
   conversation (such as Chief or a coordinator) could not consult a specialist
   Wisp directly to draw on that specialist's soul, memory, workspace, skills,
   or granted integrations.

## Decision

**Extend the Wisp tools with rich non-secret inspection, full model/fallback/memory
and circle management behind `manage_wisp` approval cards, and a bounded,
non-recursive `ask_wisp` consultation tool.**

### 1. Richer non-secret inspection (`list_wisps`, `list_circles`, `list_models`)

- `list_wisps` summary mode keeps each Wisp's ID, name, role, and model (own vs.
  app default) and adds compact hints (circle count, enabled commands/browser
  capabilities, memory off). Models and fallbacks show their display names
  and the provider and model IDs that `create_wisp` and `update_wisp` take.
- `list_wisps` detail mode (`wisp_id`) adds appearance (color and body), circle
  memberships (with lead status), installed skills (names and descriptions via
  `SkillStore`), active/paused scheduled jobs (title, schedule summary, status),
  capabilities (commands, local network, browser, workspace usage and quota),
  and plugin and MCP server access summaries (display names and access levels
  such as `read`, `write`, `use_with_approval`, and `use_without_asking`).
- **Zero-secret invariant:** inspection reads only display names, capabilities,
  and access levels. It never reads or returns credentials, API keys, OAuth
  tokens, headers, secret endpoints, or raw authentication configuration.
- `list_circles` returns each circle's ID, name, description, member Wisps
  (names and IDs, marking the lead), responder mode (`lead` | `auto`), and
  whether commands are enabled.
- `list_models` lists the models a Wisp can use: providers with a usable API
  key or sign-in, and Claude Code while it is ready. Each model shows its name,
  ID, and reasoning levels. Claude Code is marked as not usable for a fallback.
  An optional `provider` limits the list to one provider.

### 2. Extended Wisp editing & circle management (`manage_wisp`)

- `create_wisp` and `update_wisp` accept optional `memory_off`, `model`
  (`{ provider, model, thinking_level? }` or `null` for app default, validated
  through `ModelService`), and `fallback` (`"app"` | `"none"` | `{ provider,
  model }`, validated through `ModelService`). Validation runs before the
  approval card is shown so the user never approves an invalid selection.
- Before `ModelService` validates a model, the tool checks it against
  `list_models`. A display name passed for an ID gets an error naming the ID.
  An unknown provider or model, a Claude Code fallback, and an unsupported
  reasoning level each get their own error. Without these, a Wisp sees one
  generic error and cannot correct itself.
- `create_circle` and `update_circle` create or modify circles (name,
  description, validated deduplicated `member_ids`, `lead_id`, and `responder`).
  Circle changes push `wispsChanged` to all connected desktop and browser
  clients immediately.
- All Wisp and circle mutations remain under `manage_wisp`: always gated by an
  approval card showing every field being set or changed, never bypassed by
  auto-review or **Allow everything**, never offered in job runs, and still
  rejecting self-modification.

### 3. Direct Wisp consultation (`ask_wisp`)

- `ask_wisp(wisp_id, message)` consults another existing Wisp in the same
  environment and returns its reply within the caller's turn.
- **Isolated one-shot session:** `WispConsultationRunner` runs the target Wisp
  through `RoutingSessionFactory.createConsultationSession` (supporting Pi,
  Claude Code, and deterministic fake mode) in its own `consultations/` session
  folder so the target Wisp's primary conversation session and transcript are
  never corrupted.
- **Anti-loop and anti-recursion:** a Wisp cannot call `ask_wisp` on itself,
  job runs never receive `ask_wisp`, and a consultation session excludes all
  `WISP_TOOL_NAMES` (`ask_wisp`, `create_wisp`, `update_wisp`, `delete_wisp`,
  `create_circle`, `update_circle`, `list_wisps`, `list_circles`,
  `list_models`), job tools,
  `save_skill`, and `save_memory`.
- **No privilege escalation and clear attribution:** the consulted Wisp runs
  with its own identity, soul, memory (if enabled), skills, model, workspace,
  integration grants, and `WispToolPolicy`. `ToolAuthorizationBroker.routeApprovals`
  routes any approval card it triggers into the caller's conversation while
  preserving `wispId = targetWispId`, so the user sees which Wisp is asking,
  any lasting file/tool rule applies only to the consulted Wisp, and the
  caller's request deadline pauses while the card waits.
- **Cancellation and timeout:** aborting the caller's turn cancels the
  consultation and any pending approval immediately, and each consultation has
  a bounded timeout (default 5 minutes).

## Consequences

- Chief and specialist Wisps can inspect the team accurately, configure models,
  fallbacks, memory, and circles with explicit user approval, and collaborate
  on demand without requiring a circle for every cross-specialty question.
- Every security boundary from ADR 023 and ADR 024 holds: no secret leakage,
  no unapproved mutations, no privilege escalation, and no consultation loops.

## Rejected alternatives

- **Delivering `ask_wisp` into the target Wisp's main conversation session:**
  would interleave background tool consultations into the user's private chat
  history with the target Wisp and contend with active user turns.
- **Allowing nested `ask_wisp` calls up to a depth limit:** depth counters add
  latency, cost, and confusing multi-hop approval chains for minimal benefit.
  A strict single-hop consultation keeps behavior predictable and loop-free.
- **Reusing the caller's `conversationId` directly in `AgentScope`:** would
  break `ExecutionService` (which treats `conversationId !== wispId` as a
  circle), `BrowserService` (which disables the browser when IDs differ), and
  `McpService` file resolution. Routing approvals via `AsyncLocalStorage` in
  `ToolAuthorizationBroker` keeps every tool scoped to the target Wisp's own
  workspace and settings while presenting approval cards in the caller's chat.
