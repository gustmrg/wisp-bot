# ADR 042: Wisps working at the same time in a circle

- Status: Accepted
- Date: 2026-11-01
- Decision owners: Wisp maintainer, backend and renderer
- Scope: How a circle's members overlap, and what waits for what
- Related: [ADR 011](011-circles.md), [ADR 033](033-repeated-tool-failures.md)

## Context

A circle answered one of the person's messages at a time, with every handoff
included. While one member worked for minutes, the person could not ask another
anything, even a member with nothing to do: the message waited for the whole
round to end. ADR 011 chose this mainly to keep two Wisps from editing the shared
workspace at once.

Each member already has its own agent and session, so nothing in the runtime
requires it.

## Decision

**A member takes one turn at a time, and different members can work at the same
time.** There is no setting and no idea of a background task: a Wisp that hands
its task over ends its turn, is free for the next message, and the Wisp it handed
to reports back in its own reply.

- **Within a message, nothing changes.** The members it goes to answer in order,
  each seeing the replies before its own, with the same limit on handoffs.
- **Between messages,** `CircleConversationAgent` keeps a round per message
  instead of one. A round holds a member while its turn runs; a handoff to a
  member who is busy waits for it, which does not count toward the deadline.
- **What waits in the queue.** `canTake` says whether a message can start: its
  first member is free or, left to the decision model, any member is.
  `ConversationService.deliverNextQueued` takes the oldest message that can
  start, so a message can pass one waiting for a busy member, but never one for
  the same member. A message stays editable and stored until it starts.
- **A message holds its members from when it is accepted** (`reserve`), since it
  can wait for a slot before running, and each member a handoff adds. A member
  who finishes frees capacity (`onCapacity`), so the queue is looked at again with
  the round still running.
- **Registry and queue stay per conversation,** as ADR 011 chose. The registry
  sends requests of an agent with `canTake` side by side, keeps a deadline for
  each, and stops only the expired one (`abortRequest`). A round counts toward
  `MAX_SIMULTANEOUS_AGENTS`, which is what limits how many Wisps run at once
  across the app.
- **Who is working.** A turn is told which other members are working, since it
  cannot see a reply until that reply ends. `circle_turn_ended` joins
  `circle_turn_started`, so the activity line names everyone working.
- **The decision model** chooses among the members who are free, and is not asked
  when only one is. A message to the lead that went to someone else is marked as
  chosen.
- **Stop** stops every member working. Waiting messages are not dropped, as
  before.

## Consequences

- The person can keep talking to the circle while a member works for a long time.
- **Accepted risk:** members can change the shared workspace at the same time. Pi's
  file tools queue changes to one file (`withFileMutationQueue`), so writes do not
  corrupt each other, but one member can overwrite the idea of another. Members
  are told files can change while they work.
- A reply takes its place when it completes, so a reply started first can end up
  after one started later.
- A message mentioning several members starts when the first is free and holds
  the rest, so the next message to any of them waits for it.
- Approval cards pause every running deadline in the circle, not only the one
  whose member asked.

## Deferred

- **Stop for one Wisp.** Stop stops everyone for now; the backend has what it
  takes (`abortRequest` by message), but not the interface.
- **The running step for each Wisp.** With several working, the activity line
  names them without saying what each is doing.
- **Keeping members' files apart,** with a git worktree for each, or a lock over
  the workspace, if real use shows conflicts.

## Decisions taken with the user

- A member can only do one thing at a time, and a finished member says so in its
  reply; no background task is added.
- The message that waits for a busy member stays in the queue.

## Rejected alternatives

- **Registry entries per `(conversation, Wisp)`:** rejected in ADR 011 for the same
  reason: every queue, status, and Stop would have to learn about circles.
- **Delivering every message at once and waiting inside the agent:** a message
  waiting for a member would join the transcript early, and could no longer be
  edited or survive a restart.
- **Running background work as jobs:** they deliver to a Wisp's own conversation,
  show only their result, and cannot be interrupted.
- **Answering with the lead when the model's choice is busy:** the model chooses
  among those free instead, so it never picks a member who cannot answer.
