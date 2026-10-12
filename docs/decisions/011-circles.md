# ADR 011: Circles with agents

- Status: Proposed (draft)
- Date: 2026-10-07
- Decision owners: Wisp product and agent runtime
- Scope: A conversation between the person and several Wisps
- Related: [ADR 010](010-wisp-entity.md), [ADR 001](001-agent-runtime.md),
  [ADR 008](008-wisp-skills.md)

## Context

[ADR 010](010-wisp-entity.md) stored Wisps apart from conversations. A circle
lists Wisps (`memberIds`), every conversation record holds a map of agent
sessions per Wisp, incoming messages carry an `authorId`, and the Wisps in a
conversation share its workspace. Circles still have no agents: nothing
answers a message sent to one, and the app has no way to create one.

The runtime assumes one agent per conversation. These are all keyed by
conversation ID alone:

- the agent registry (`AgentRegistry` entries, statuses, events);
- tool approvals (`ToolApprovalRequest.conversationId`);
- the message queue and scheduled messages;
- integration grants (`resolveWisp(conversationId)`);
- usage rows (`WispUsageRow.conversationId`) and session reports;
- context settings, stored with the Wisp rather than with each session.

## Open questions

Each question lists the options and a recommendation. The recommendations
are proposals until the decision owners accept them.

### 1. Who answers a message

| Option | Behavior | Trade-off |
|---|---|---|
| A. Everyone | Every member replies, in member order | Predictable, but costly and noisy with more than two Wisps |
| B. Mentions | `@Atlas` addresses Atlas; several mentions reply in mention order | Explicit and cheap; the person must name someone |
| C. Router | A model call picks who answers | Feels natural; an extra model call per message, and harder to predict |

**Recommendation: B, with a lead as fallback.** A message with mentions goes
to the mentioned Wisps. A message without mentions goes to the circle's lead
(a member the person picks; the first member by default). The router (C) can
come later as a lead that delegates.

### 2. Turn order

**Recommendation: one Wisp at a time.** Each reply finishes before the next
Wisp starts, and each Wisp sees the replies before its own. Turns in a circle
never run in parallel, which also keeps two Wisps from editing the shared
workspace at once. Stopping the circle stops the current turn and drops the
remaining ones.

### 3. Wisps addressing each other

A Wisp may mention another member in its reply to hand the task over.

**Recommendation: allow handoffs, with a limit.** A handoff adds that Wisp's
turn to the queue. One message from the person allows at most three
handoffs, after which the circle waits for the person. A Wisp cannot hand off
to itself or to a Wisp outside the circle.

### 4. What each Wisp sees

Each member has its own agent session in the circle (the `sessions` map),
created on its first turn, in its own `pi-sessions/<id>` folder.

**Recommendation:** before each turn, the backend adds the messages since that
Wisp's previous turn to its session: the person's messages as they are, and
other Wisps' replies labeled with their names (`Atlas said: …`), marked as
another participant's words rather than instructions. The system prompt
gains a circle section: the circle's name and description (its purpose), and
each member's name and role. Each Wisp keeps its own soul, skills, saved
memory, and model.

### 5. Tools, grants, and approvals

- **Grants:** each Wisp uses its own integration grants in every
  conversation. The grant lookup becomes `(conversationId, wispId)` and
  resolves to the Wisp's storage ID.
- **Workspace:** the circle's shared workspace (`workspaces/<circle storage
  ID>`). Sequential turns avoid concurrent edits.
- **Approvals:** requests and audit entries add `wispId`, so the approval card
  says which Wisp is asking.

### 6. Runtime keys

The registry keys agents by `(conversationId, wispId)`. A Wisp's own
conversation keeps exactly one agent, so its behavior does not change. Agent
events, statuses, and errors add `wispId`. A circle's status is `working`
while any turn runs.

### 7. Queue and scheduling

The queue stays per conversation. A queued or scheduled message for a circle
is routed by the same rules as one typed then (question 1) when the circle
takes it.

### 8. Context settings

Renewal policy moves from the Wisp to each session: a Wisp's settings become
the default for its sessions, and a circle can override them. Saved memory
stays with the Wisp.

### 9. Usage and reports

Usage rows stay per Wisp and add up its sessions in every conversation.
Session reports open per `(conversationId, wispId)`. The circle settings show
each member's usage in that circle.

### 10. Interface

- Create a circle: name, description, members, lead.
- Each incoming message shows its author's avatar and name.
- The composer completes `@` mentions from the circle's members.
- The activity line names the Wisp working ("Atlas is working…").
- Circle settings: members, lead, description, notifications.

## Delivery

1. **Circles without agents:** create circles from the app, choose the lead,
   show authors on messages, and say that circles cannot answer yet.
2. **Agents in circles:** runtime keys by `(conversationId, wispId)`, mention
   and lead routing, sequential turns, per-session context, approvals and
   usage with `wispId`, mention autocompletion.
3. **Handoffs** between Wisps, with the limit.

## Decisions needed

- Question 1: mentions with a lead fallback, or another option?
- Question 3: allow handoffs in the first release, and is three the right
  limit?
- Question 8: may a circle override its members' renewal policy?
