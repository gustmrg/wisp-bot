# ADR 043: Background tasks in a Wisp's own conversation

- Status: Proposed
- Date: 2026-11-02
- Decision owners: Wisp maintainer, backend and renderer
- Scope: Work a Wisp runs beside its own conversation, and how the person
  follows and stops it
- Related: [ADR 011](011-circles.md), [ADR 017](017-container-execution.md),
  [ADR 019](019-scheduled-jobs.md), [ADR 026](026-claude-code-runtime.md),
  [ADR 033](033-repeated-tool-failures.md),
  [ADR 042](042-wisps-working-at-the-same-time.md), SWE-289

## Context

A Wisp doing development work ([ADR 017](017-container-execution.md)) spends
minutes on one turn: it clones, installs, builds and runs tests, up to the
request's 10-minute deadline. Its conversation is busy all that time. A
message sent meanwhile goes to the running turn as a **Follow-up**, or waits
in the queue. The person cannot ask the same Wisp for a second, unrelated
thing until the first ends. They wait, or make another Wisp for it.

[ADR 042](042-wisps-working-at-the-same-time.md) solved this for circles:
different members work at the same time, and each member does one thing at a
time. It recorded with the user that no background task is added, and
rejected running background work as jobs because they "deliver to a Wisp's
own conversation, show only their result, and cannot be interrupted". A
Wisp's own conversation has one member, so ADR 042's answer does not reach
it. This ADR proposes background tasks there and answers those three
objections. It reopens a decision taken with the user, so it stays Proposed
until the user decides.

Most of what a task needs exists:

- **Job runs** ([ADR 019](019-scheduled-jobs.md)) run in a session of their
  own, made by `JobSessionFactory` for Pi and Claude Code, with the Wisp's
  model, identity, plugins, workspace and container but none of the
  conversation's history. Their final response becomes a Wisp message that
  also enters the main session's context, so the person can follow up.
- **The agent registry** ([ADR 042](042-wisps-working-at-the-same-time.md))
  runs requests side by side, keeps a deadline for each, stops one alone
  with `abortRequest`, and caps the app at `MAX_SIMULTANEOUS_AGENTS`.

**Prior art.** DeepSeek Harness's "Super-agent" design (November 2026)
splits an agent into a router that talks to people and only dispatches, and
isolated workers that do the work and report back. In their ablation, a
single session told it may delegate did not delegate in any of 5 runs with
a neutral prompt, and did in 4 of 5 with one that insisted; in the fifth,
the model judged the work small and did it itself, which gave the long tail
of completion times. Their
results are from synthetic workloads and are only indicative. ADR 011 saw the
same from the other side: a stronger handoff instruction made Wisps pass on work they
had just done. Whether work goes to the background should not rest on the
prompt alone.

## Decision

**A Wisp can run a task: one piece of work in a session of its own, beside
its conversation. The conversation stays free, the person sees each task
and can stop it, and the task's result arrives as the Wisp's message.**

### Starting a task

- **`start_task`:** a Wisp tool offered in the Wisp's own conversation, with
  a short `title` and self-contained `instructions`, written as a job's are,
  since the task does not see the conversation. It returns at once
  ("Started task t3"); the Wisp says so in a sentence and ends its turn.
  It is not offered in circles, job runs, or tasks, so a task cannot start
  another.
- **Run in background:** the composer's **+** menu gains **Run in
  background**, beside **Schedule**. The message goes to the Wisp as usual,
  but that turn offers only `start_task`, the read-only workspace tools and
  `search_history`: no commands, file changes, integrations or browser. The
  Wisp writes the task's instructions and cannot do the work itself, which
  is the router's rule in the prior art, enforced by the app and not asked
  of the model.
- **No card to start one.** A task has the Wisp's tools and asks for the
  same approvals as a turn would, so starting it grants nothing new. A job
  needs a card because approving it authorizes tools for runs no one
  watches.

### Running

- **Session:** made by `JobSessionFactory`, with the Wisp's model, soul,
  memory when it is on, skills, plugins, MCP servers, workspace and
  container. Its prompt holds the instructions, the time, and that other
  work may change the workspace meanwhile.
- **Attended, unlike a job run.** The person is around, so a task's
  approvals are ordinary cards in the conversation, naming the task, and its
  deadline pauses while one waits, as a turn's does.
- **Limits:** two tasks per Wisp at a time; more wait in line. Each holds
  one of the registry's slots, like a turn. A task may run for 30 minutes.
- **Repeated failures:** the `ToolLoopGuard`
  ([ADR 033](033-repeated-tool-failures.md)) stops a task as it stops a
  turn. Job sessions do not expose tool events yet, so task sessions must.
- **Workspace:** the conversation's, with ADR 042's accepted risk: the
  conversation, tasks and background processes can change files at the same
  time. Pi queues writes to one file, but nothing stops a task from
  overwriting another's idea. The prompt suggests a git worktree per task
  for repository work.
- **Where:** in the backend that owns the Wisp. On a Wisp server a task
  keeps running with every app closed. Quitting the desktop app stops its
  tasks, which end as stopped and are not resumed.

### What the person sees

ADR 042's three objections, in order:

- **Delivery:** a task belongs to the Wisp's own conversation, which is
  where its result belongs.
- **More than the result:** starting a task adds a task card to the
  conversation, with its title, status (waiting, running, waiting for
  approval, done, failed, stopped), time so far, and the current step as
  the activity line names it in a turn. The card stays in the transcript
  with the final status.
- **Interruptible:** the card's **Stop** stops that task alone
  (`abortRequest`). The conversation's **Stop** stops the turn being
  written, not tasks. The Wisp gets `list_tasks` and `stop_task` for "stop
  the second one".

The task's final response is added as a Wisp message marked with the task,
unread and notifying like a reply, and enters the main session's context
(`appendCustomMessageEntry`), as a job's result does. A failed task posts its
error the same way, so the Wisp knows it failed.

### Records

- Tasks are stored with the Wisp's records in a new table: ID, Wisp, title,
  instructions, status, when it was created, started and ended, error,
  session file, and usage. The change is additive, so it raises
  `STORE_VERSION` and not `MIN_READER_VERSION`. The last 50 tasks of a Wisp
  are kept, like a job's runs.
- Usage reports show tasks per Wisp, apart from turns and job runs.

### Delivery

1. **Backend:** the task runner on `JobSessionFactory`, `start_task`,
   `list_tasks`, `stop_task`, records, limits, and tool events for the loop
   guard.
2. **Interface:** the task card with **Stop**, and task results in the
   transcript.
3. **Composer:** **Run in background**, with its restricted turn.

## Consequences

- The person can hand a Wisp long work and keep talking to it, or give it
  several pieces of work at once.
- A Wisp can do more than one thing at a time in its own conversation, which
  a circle member cannot (ADR 042).
- Each task is a session of its own, with the full system prompt and none of
  the conversation's prompt cache, so tasks cost more tokens than the same
  work done in a turn.
- Conflicting changes in the workspace become likelier, and approval cards
  can come from several places at once; each card names its task.
- A task's tool calls do not appear in the transcript, only its card and
  result, as with job runs.

## Deferred

- **Messages to a running task.** A follow-up goes to the conversation; to
  change a task's course, stop it and start another. Relaying messages to
  the task that owns a thread is the prior art's next step.
- **A task's transcript** from its card, as a job run's record shows its
  session, and a tool for the Wisp to read what a task or job run did
  (SWE-291).
- **Tasks in circles,** where a member running work beside its turns would
  undo ADR 042's one thing at a time.
- **A git worktree per task** made by the app, if prompting is not enough.
- **Tasks that survive a restart.**
- **A progress check** beyond the loop guard, such as stopping after several
  model calls in which no tool succeeds (deferred in ADR 033, SWE-292).

## Decisions taken with the user

None yet. To decide:

1. Whether to reopen ADR 042's "no background task" for a Wisp's own
   conversation.
2. How a task starts: `start_task`, **Run in background**, or both
   (proposed).
3. Approvals in a task: cards in the conversation (proposed), or refused
   as in a job run.
4. The limits: two tasks per Wisp, 30 minutes each.
5. Whether the conversation's **Stop** also stops its tasks.

## Rejected alternatives

- **Only telling the Wisp to delegate in its prompt:** the prior art's
  ablation and ADR 011 both show the model's choice is unreliable.
  **Run in background** gives the person a way that does not depend on it.
- **A `once` job run now:** it is unattended and refuses what would ask,
  shows only its result, cannot be stopped from the conversation, and needs
  a card to create: ADR 042's objections, unchanged.
- **A new conversation per task:** results would scatter across
  conversations, and the person could not follow up where they talk to the
  Wisp, as ADR 019 found for job runs.
- **A second Wisp, or a circle, for parallel work:** it works today (ADR
  042), but asks the person to copy a Wisp's soul, memory and grants for
  what is one Wisp's work.
- **Running the work in the conversation's own session:** one session runs
  one turn at a time.
