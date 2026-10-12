# ADR 019: Scheduled jobs that Wisps run in the background

- Status: Proposed
- Date: 2026-10-11
- Decision owners: Wisp backend and renderer
- Scope: Tasks a Wisp runs on a schedule without anyone present, and where their results go
- Related: [ADR 001](001-agent-runtime.md), [ADR 008](008-wisp-skills.md), [ADR 009](009-headless-server.md),
  [ADR 017](017-container-execution.md), [ADR 018](018-native-mobile-app.md)

## Context

People want Wisps to do work on their own at set times:

- "Every day at 10:00, search for job openings that match me and send me what
  you found."
- "Every Saturday, check these blogs and tell me if any posted something new."

Wisp already has **scheduled messages** (`backend/message-scheduler.ts`): a
message the person writes is sent to the Wisp later, as if typed then. The
scheduler sends due messages with no client connected, catches up after the
backend was stopped, and claims a message (advances or removes it) before
sending, so a crash can lose a send but never repeat one. Only one-off sends
exist, and only the composer creates them.

Scheduled messages do not fit these jobs:

- **They run in the conversation.** The prompt and every tool call land in the
  transcript and in the model's context, every day. A week of job searches
  fills the conversation with work the person never asked to see.
- **They always answer.** "Check the blogs" with nothing new still produces a
  reply. A job should be able to finish silently.
- **They forget between sends.** Knowing which posts are new needs what the
  last run saw.
- **They can block on approval.** With a window open, a tool that needs
  approval waits up to 60 seconds for someone to answer
  (`backend/tool-authorization-broker.ts`); with none open, it is refused.
  Neither is a decision made for a run with no one present.

## Decision

**A job is a task a Wisp runs in its own background session on a schedule,
which delivers only its result to the Wisp's conversation.**

### What a job is

- **Fields:**
  - the Wisp and conversation it belongs to;
  - a short title;
  - the instructions;
  - the skills loaded into every run, from the Wisp's own
    ([ADR 008](008-wisp-skills.md));
  - the tools a run may use (see below);
  - a schedule and the IANA time zone it was created in;
  - the next run;
  - whether it is paused, and why;
  - a small saved state;
  - counters for runs and consecutive failures;
  - the outcome of the last run: its status, run error and delivery error,
    kept apart.

  Jobs are stored with the Wisp's other records and deleted with it.
- **Limits:** 20 jobs per Wisp. The last 50 runs of each job are kept.
- **Schedules** are structured, not cron strings, so they can be validated,
  shown in the UI and read back to the person:
  - `once` at a time;
  - `daily` at a local time;
  - `weekly` on chosen weekdays at a local time;
  - `monthly` on a day of the month at a local time. On a day the month does
    not have, such as the 31st, the job runs on the month's last day.

  Recurring kinds take an optional end date or run count. Nothing runs more
  than once a day in this version.
- **Wall-clock times follow the job's time zone,** also on a server in another
  zone. A time skipped when clocks go forward runs at the first valid minute
  after it (02:30 becomes 03:00). A time that happens twice when clocks go
  back runs once, at the first instance.

### Only the Wisp creates jobs

Jobs are created by asking a Wisp in its conversation ("every Saturday, check
these blogs…"). The Wisp has four tools:

- `schedule_job`
- `list_jobs`
- `update_job`
- `cancel_job`

They act only on jobs of the conversation they are called from. The UI has no
form to create jobs. It does have a list where the person can see, pause,
resume, run now and delete them (see below).

**The person approves each job.** `schedule_job`, and an `update_job` that
changes the instructions or adds tools, shows an approval card. The card
lists:

- the title;
- the schedule in words, with the next run;
- the instructions;
- the skills;
- the tools.

Approving the card is the authorization for those tools in that job's runs,
which have no one to ask (see "No one is present"). A Block rule still wins.
A created or changed job then stays in the transcript as a card with its next
run.

**The Wisp writes self-contained instructions.** A run does not see the
conversation that created it, so the instructions carry everything the run
needs:

- the sources and how to reach them (the blogs, the search queries, the API);
- what counts as worth reporting;
- the language and format of the message, including a heading with the date.

The instructions do not repeat the schedule. The run's prompt states when it
runs, so a copy in the instructions could go out of date after `update_job`.

### How a run works

1. **Due:** the scheduler claims the occurrence by advancing `nextRunAt` before
   the run starts, as the message scheduler does today. A crash loses that run
   but never repeats it.
2. **Session:** the run starts a separate Pi session. It uses the Wisp's model,
   system prompt, plugins, MCP servers, workspace and container, plus the
   job's skills, but none of the conversation's history. The run's prompt
   holds:
   - the instructions;
   - the saved state;
   - when the job last ran;
   - the scheduled time and the actual time, when the run is late;
   - a note that no one is present.

   The run's session file is kept with its run record for debugging.
3. **No one is present:** the run is marked unattended for the authorization
   broker. A run offers only the job's tools that the Wisp still has. Commands
   in the Wisp's container ([ADR 017](017-container-execution.md)), such as
   `curl` or a search CLI, need no approval anyway. A file change asks in a
   conversation, but in a run it is allowed because the person approved the
   job with that tool. Whatever would still ask is refused at once. The model
   is told why and continues, and nothing ever waits for an approval card.
   Tools that ask the person something (such as SSH questions) and the job
   management tools are never offered, so a job cannot schedule more jobs.
4. **Finishing:** the run's final response is its message, as in a
   conversation, so the model does not have to remember a special call to
   deliver. Two tools exist only in runs:
   - `skip_delivery`: ends the run with no message, as in "no new posts". It
     takes a short reason, which goes in the run record.
   - `save_job_state`: replaces the saved state (at most 16 KB) for the next
     run.

   An empty final response without `skip_delivery` counts as failed.
5. **Limits:**
   - one run per job at a time;
   - two runs at once per backend (more wait in line);
   - 15 minutes per run, then it is stopped and counts as failed.

### Where results go

- **The conversation.** A run's message is added to the Wisp's conversation as
  a Wisp message marked with the job that produced it. It counts as unread and
  notifies like a reply.
- **The model's context.** The message also enters the main Pi session as a
  custom message (`appendCustomMessageEntry`), so the person can follow up
  ("tell me more about the third opening") and the Wisp knows what it said.
  Delivering it does not start a model turn. While the Wisp is answering
  something else, delivery waits until that turn ends.
- **Elsewhere:** other destinations, starting with Discord, are deferred
  ([SWE-143](https://linear.app/gustavomrg/issue/SWE-143)).

### Missed runs and failures

- **Missed runs:** runs missed while the backend was stopped collapse into one
  run as soon as it starts. A week offline gives one job search, not seven. A
  `once` job missed this way still runs. The prompt says it is late.
- **Retries:** a run that fails for a reason that may pass (provider, network
  or rate-limit errors) is retried twice, 5 and then 15 minutes later, unless
  the next occurrence comes first.
- **Pausing after failures:** after 3 failed occurrences in a row, the job
  pauses itself and a notice in the conversation says why. A successful run
  resets the count.
- **Run records:** each run records:
  - its scheduled time, start and end, and how late it started;
  - how it was started: `on_time`, `catch_up`, `retry` or `manual`;
  - its status: `delivered`, `silent`, `failed` or `skipped`;
  - the run's error code, and separately a delivery error;
  - the reason given to `skip_delivery`;
  - token usage.

  A failed delivery does not repeat the run. The UI shows the last runs.

### Where jobs run

Jobs run in the backend that owns the Wisp:

- **Wisp server** ([ADR 009](009-headless-server.md)): runs around the clock.
  This is the home for jobs that must run while the person's computer is off.
- **Desktop:** jobs run while the app's backend is running and catch up when
  it starts.
- **Phone with Wisps on the device** ([ADR 018](018-native-mobile-app.md)): out
  of scope. Mobile operating systems do not let an app run agent sessions on a
  schedule.

### Managing jobs

A jobs list covers every Wisp, in desktop and mobile layouts, with the next
run, the last run and its status, and recent failures. From it the person can:

- pause and resume a job;
- run it now;
- delete it;
- open a run's record.

Changing a job's instructions or schedule is done by asking the Wisp.

### Relation to scheduled messages

Scheduled messages stay as they are: the person's own message, sent later.
Both features share the schedule kinds and the time-zone-aware
`nextOccurrence`, which moves to a module both use. This means scheduled
messages can gain recurrence later at little cost. Both also share the
claim-before-run loop.

## Consequences

- Wisps can watch for things and report back without the person present, on
  a server or on a running desktop.
- The conversation shows only results, but the Wisp still remembers them.
- A job can use only the tools approved with it. Its card is the one place to
  review what it may do unattended. A job that needs another tool fails
  visibly, in the run record and the failure notice, until the Wisp updates
  it and the person approves again.
- Jobs spend tokens and provider credits unattended. Usage is recorded per
  run. A spending cap is not part of this decision.
- Notifications reach only open clients. A notification with every client
  closed (desktop tray, web push for the browser app) is deferred.
- The authorization broker gains an unattended mode, and a Wisp message can now
  arrive without a user message before it. Transcript rendering, unread counts
  and paging handle the new message kind.

## Prior art: Hermes Agent

Hermes Agent stores cron jobs as JSON records. Several choices here come from
there:

- **The prompt is written by the agent and stands alone.** It says which
  sources and commands to use, the output language and format, and that the
  final response is what gets delivered.
- **Skills and tool sets are chosen per job.** A job loads the skills it
  relies on, and its tools are limited to sets such as terminal and web.
- **The final response is the delivery.**
- **Last status, run error and delivery error are kept apart,** with a
  failure streak.
- **Each dispatch records** its scheduled time, lateness and whether it was on
  time or a catch-up.
- **A fire claim** guards against running an occurrence twice.

What differs:

- Wisp stores an IANA time zone instead of the machine's local time.
- Schedules are structured instead of cron expressions.
- The person approves each job.
- A run can finish silently.

## Deferred

- Per-job model overrides; runs use the Wisp's model.
- Jobs that run a script without a model, for cheap fixed checks.
- Jobs that receive another job's output.
- Destinations other than the conversation
  ([SWE-143](https://linear.app/gustavomrg/issue/SWE-143)).

## Decisions taken with the user

- A job's result enters the Wisp's context, so the person can follow up on it.
- Jobs are created only by asking a Wisp, not from a form.
- Jobs must be able to run while the person's computer is off, so the Wisp
  server is a supported place to run them.
- Discord delivery is wanted but deferred
  ([SWE-143](https://linear.app/gustavomrg/issue/SWE-143)).

## Rejected alternatives

- **Recurring scheduled messages.** These are simple to build but put every
  run's prompt and tool calls into the conversation. They always answer, have
  no memory between runs and cannot finish silently.
- **Running jobs in the conversation's own session.** A run would compete with
  the person's turns for the same session, and its tool calls would fill the
  context.
- **A new conversation per run.** Results would be scattered across
  conversations the person has to find, and they could not follow up where
  they talk to the Wisp.
- **Cron or RRULE strings.** These are hard to validate and to show the person,
  and easy for the model to get subtly wrong. Structured kinds cover the
  current use cases. More kinds can join the union later.
- **Keeping job state in a workspace file.** This depends on the model
  remembering to write it, needs file-write approval, and mixes job state with
  the person's files.
- **A required `finish_job` call carrying the message.** A model that forgets
  the call fails a run that otherwise worked. The final response already is
  the answer, so only the exceptions (no message, new state) need tools.
- **Waiting for approval during a run.** No one is there to answer, and a run
  that waits holds a slot until it times out.
