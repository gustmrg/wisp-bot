# ADR 011: Circles with agents

- Status: Accepted
- Date: 2026-10-07, accepted 2026-10-20
- Decision owners: Wisp product and agent runtime
- Scope: A conversation between the person and several Wisps
- Related: [ADR 010](010-wisp-entity.md), [ADR 001](001-agent-runtime.md),
  [ADR 008](008-wisp-skills.md), [ADR 023](023-wisp-permissions.md),
  [ADR 026](026-claude-code-runtime.md), SWE-114, SWE-176

## Context

[ADR 010](010-wisp-entity.md) stored Wisps apart from conversations. A circle
lists Wisps (`memberIds`), every conversation record holds a map of agent
sessions per Wisp, incoming messages carry an `authorId`, and the Wisps in a
conversation share its workspace. Circles still have no agents: nothing
answers a message sent to one, and the app has no way to create one.

The runtime assumes one agent per conversation, and several parts use the
conversation ID to find the Wisp:

- integration grants, Wisp permissions, and the tool snapshot
  (`resolveWisp(conversationId)`, `getSnapshot(conversationId)`);
- tool approvals (`ToolApprovalRequest.conversationId`);
- the fallback model and the tool revision a session is rebuilt for;
- the transcript a replaced Claude Code session is told
  ([ADR 026](026-claude-code-runtime.md)).

## Decision

**A circle answers with its members' own agents, one turn at a time. A
message that mentions members goes to them, in mention order; any other
message goes to the circle's lead. Each Wisp keeps its soul, skills, memory,
model, grants, and permissions, on Pi or on Claude Code.**

### 1. Who answers a message

| Option | Behavior | Trade-off |
|---|---|---|
| A. Everyone | Every member replies, in member order | Predictable, but costly and noisy with more than two Wisps |
| B. Mentions | `@Atlas` addresses Atlas; several mentions reply in mention order | Explicit and cheap; the person must name someone |
| C. Router | A model call picks who answers | Feels natural; an extra model call per message, and harder to predict |

**Chosen: B, with the lead as fallback.** A message with mentions goes to the
mentioned Wisps, in the order they are first mentioned. A message without
mentions goes to the circle's lead. The lead is the first member: choosing a
lead moves that Wisp to the front, so the member order the store already
keeps holds it, with no column of its own. A router (C) can come later as a
lead that delegates.

A mention is `@` and a member's name, matched without regard to case, and
not followed by a letter or digit, so `@Ada` does not match `@Adam`. The
longest name wins when names share a prefix.

### 2. Turn order

**One Wisp at a time.** Each reply finishes before the next Wisp starts, and
each Wisp sees the replies before its own. Turns in a circle never run in
parallel, which also keeps two Wisps from editing the shared workspace at
once. Stopping the circle stops the current turn and drops the remaining
ones.

### 3. Wisps addressing each other

A Wisp may mention another member in its reply to hand the task over.

**Allowed, with a limit.** A handoff adds that Wisp's turn after the turns
already waiting. One message from the person allows at most three handoffs,
after which the circle waits for the person. A Wisp cannot hand off to itself
or to a Wisp outside the circle, and a Wisp already waiting is not added
again. A Wisp whose turn failed in the round is not added again either
([ADR 033](033-repeated-tool-failures.md)).

### 4. What each Wisp sees

Each member has its own agent session in the circle (the `sessions` map), in
its own session folder. The session record is made when the Wisp joins the
circle; the runtime session itself opens on the Wisp's first turn, as in a
Wisp's own conversation.

Before each turn the circle tells the Wisp the messages since its own last
reply in the circle, read from the circle's transcript: the person's
messages as they are, and other Wisps' replies labeled with their names and
marked as another participant's words rather than instructions. A turn whose
only new message is the person's gets that message alone, as in a Wisp's
own conversation.

The system prompt gains a circle section: the circle's name and description
(its purpose), each member's name and role, and that the Wisp writes only its
own reply.

### 5. Tools, grants, and approvals

- **Grants and permissions:** each Wisp uses its own integration grants and
  its own permissions ([ADR 023](023-wisp-permissions.md)) in every
  conversation. Tool sources and the authorization broker find the Wisp by
  its ID and the conversation by its ID, separately; in a Wisp's own
  conversation the two are the same.
- **Workspace:** the circle's shared workspace (`workspaces/<circle storage
  ID>`). Sequential turns avoid concurrent edits. Its size belongs to the
  circle, not to its members: it is kept in `circle-config/<circle storage
  ID>`, starts at the default, and is changed in the circle's details or in
  Storage like a Wisp's. Every member's writes are checked against it, and
  deleting the circle archives that folder with the workspace.
- **Approvals:** requests and audit entries add `wispId`, so the approval card
  says which Wisp is asking.
- **Commands:** a Wisp's container mounts its own workspace
  ([ADR 017](017-container-execution.md)), so `run_command` and `process`
  are not offered in circles. A container per circle can come later.
- **Jobs:** a job delivers to its Wisp's own conversation
  ([ADR 019](019-scheduled-jobs.md)), so the job tools are not offered in
  circles either.

### 6. Runtime

The agent registry keeps one entry per conversation. A circle's entry is a
circle agent that holds one agent per member, each built by the same factory
as a Wisp's own agent and given a context for the Wisp in the circle: the
circle's ID and workspace, the Wisp's session there, and the Wisp's own
settings and model. So:

- the registry, the message queue, scheduled messages, statuses, and Stop
  stay per conversation, as they are;
- a circle is `working` while any turn runs, and each turn gets the request
  deadline of its own;
- agent events add `wispId`, and each reply's message ID names its Wisp
  (`<request>:<wisp>:assistant`), so replies to one message never collide;
- a follow-up sent while a circle works waits for the round to end, and is
  routed then.

A member that fails or is not configured gets a failed reply with the
reason, and the next turn runs. The person's message stays sent: only that
Wisp's reply failed.

### 7. Queue and scheduling

The queue stays per conversation. A queued or scheduled message for a circle
is routed by the same rules as one typed then (question 1) when the circle
takes it.

### 8. Context settings

Each Wisp's context policy and saved memory apply to its sessions in circles
too. A circle does not override them for now.

### 9. Usage and reports

Usage rows stay per Wisp, and each session writes its usage in its own folder
as it does now. A circle's settings also show its members' usage in that
circle alone, read from their session folders there.

### 10. Claude Code

Wisps on Claude Code ([ADR 026](026-claude-code-runtime.md)) join circles
like Wisps on Pi. A member's Claude Code session runs in the circle's
workspace, so every member on Claude Code shares one Claude Code project
there. What Claude Code keeps is deleted per session, not per project, where
members share one:

- each member's session folder records every Claude Code session it used,
  including those a new topic or a lost session replaced;
- removing a member, or deleting a Wisp that is a member, deletes its
  sessions in that circle with the Agent SDK's `deleteSession`, once its
  processes there exited, and leaves the other members' sessions alone;
- deleting a circle purges its whole project, as deleting a Wisp purges its
  own;
- the transcript told to a replaced session, or to the fallback model, names
  each message's author.

### 11. Interface

- Create a circle: name, description, members, lead.
- Each incoming message shows its author's avatar and name.
- The composer completes `@` mentions from the circle's members.
- The activity line names the Wisp working ("Atlas is working…").
- Circle settings, in tabs: General (name, label, description,
  notifications), Members (members and lead), Workspace, and Usage.

## Delivery

1. **Creating circles:** create circles from the app and choose the lead.
   Circles still say they cannot answer.
2. **Wisp and conversation apart:** tool sources, permissions, approvals,
   fallbacks, and tool revisions take the Wisp's ID beside the
   conversation's. A Wisp's own conversation behaves as before.
3. **Agents in circles:** the circle agent, routing, what each Wisp sees,
   per-session Claude Code data, and the composer, mentions, and activity
   line.
4. **Handoffs** between Wisps, with the limit.

## Consequences

- A person can bring several Wisps into one conversation and address them by
  name, paying for one turn per Wisp that answers.
- A Wisp behaves the same in a circle as in its own conversation, except that
  it cannot run commands or manage jobs there.
- Removing a member forgets that Wisp's history in the circle; adding it
  again starts a new session.

## Rejected alternatives

- **Registry entries per `(conversation, Wisp)`:** every queue, status, and
  Stop would have to learn about circles, and a circle's status would be
  derived from several entries. One entry per conversation keeps them as
  they are.
- **A separate lead field:** a column and a migration for what the member
  order already says.
- **Purging a circle's Claude Code project when one member leaves:** it would
  delete the other members' sessions too.
- **Checking each member's writes against its own Wisp's workspace size:**
  the shared workspace had as many limits as members, none of them the one
  Storage showed, and a circle's size could not be changed at all.
