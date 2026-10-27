# ADR 033: Job runs that acted outside Wisp are not retried

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp maintainer, backend
- Scope: Which failed job runs are retried, and which tool calls count as
  acting outside Wisp
- Related: [ADR 005](005-remote-mcp-servers.md),
  [ADR 017](017-container-execution.md), [ADR 019](019-scheduled-jobs.md),
  [ADR 023](023-wisp-permissions.md), [ADR 028](028-wisp-browser.md), SWE-239

## Context

ADR 019 retries a run that fails for a reason that may pass, such as a rate
limit or a provider error, 5 and then 15 minutes later. A retry starts the run
over. When the failed attempt had already sent an email, created an issue, or
submitted a form, the retry does it again, and the person gets two emails or
two issues.

The scheduler already avoids repeating a run after a crash: an occurrence is
claimed before its run starts, so a crash can lose a run but never repeat one.
Retries had no such care.

OpenMausBot's runtime contract has the same rule for a turn cut off by a
restart: it runs again at most once, and never once it took an outward action
(sent, posted, pushed, paid). It reads that from the thread's activity, not
from what the model wrote.

## Decision

**A run that fails for a reason that may pass is not retried when it already
took an action outside Wisp.** The run's record says which tools kept it from
being retried, and a notice in the conversation says so.

- The authorization broker knows every action allowed in an unattended run
  (`runUnattended`), so it is the source, never the model's text.
  `UnattendedGrant.onExternalAction` is told the tool's name when an action in
  `EXTERNAL_ACTION_CATEGORIES` is allowed, before it runs.
- `JobRunner` passes the run's `JobRunContext.recordExternalAction` as that
  callback, and `JobScheduler` keeps the names for the run.
- When the run fails with a retryable error and has names, the scheduler
  stores them as `JobRun.notRetriedAfter`, schedules no retry, and counts the
  occurrence as failed. Three failed occurrences in a row still pause the job.
- A run that failed without acting outside keeps the retries of ADR 019.
- **Settings → Jobs** shows "not retried after" and the tools' names in the
  run's details. The notice tells the person to run the job from the jobs list
  if it should try again.
- `job_runs` gains the column `not_retried_after` (store version 14). Older
  builds ignore it and leave it alone when they update a run.

### What counts as acting outside

- **External writes** of plugins, such as a Gmail draft or a calendar event.
- **Every MCP call** (`integration_call`). Server annotations are untrusted
  (ADR 005), so a tool that says it only reads may still write.
- **Browser actions that send something** (`browser_submit`): a button, a
  form sent with POST, or a password.

Container commands do not count. The container is the boundary (ADR 017), and
most jobs that work on code run commands, so counting them would end their
retries. A command that reaches outside, such as `git push`, is not told
apart from one that does not.

An action counts once it is allowed, even if the tool then fails: a request
that timed out may still have reached the service.

## Consequences

- A job that fails after sending something no longer sends it twice. The
  occurrence is lost instead, and the person can run it again by hand.
- A job that uses an MCP tool loses its retries even when that tool only
  reads. Waiting for the next occurrence is the safer mistake.
- The record and the notice name the tools, so the person knows what may
  have happened before the failure.

## Deferred

- Turns in conversations that stop after the same tool fails the same way
  several times, and circle handoffs to a member that just failed
  (SWE-239's second part).
- Trusting an MCP tool's read-only annotation once the person marks the
  server as trusted.
- Telling the model in a retry what the failed attempt already did, so it
  could finish the rest.

## Decisions taken with the user

- Implement after tool discovery, as the next issue of the plan (SWE-239),
  with retries in their own pull request.

## Rejected alternatives

- **Counting container commands.** It would end the retries of almost every
  job that runs code, for the few commands that reach outside.
- **Counting MCP calls only when not annotated as read-only.** The
  annotations come from the server, which Wisp does not trust for
  permissions either.
- **Asking the model in the run's final reply what it did.** A failed run
  often ends without one, and the model's account is not a record.
- **Retrying with a note of what was already done.** The run starts with no
  history, so the model could not check what happened, and it would still
  depend on the model to avoid repeating it.
