# Scheduled jobs

A job is a task a Wisp runs on its own on a schedule, such as "every day at
10:00, search for job openings that match me and send me what you found".
Each run happens in a background session of its own, and only its result
reaches the Wisp's conversation ([ADR 019](decisions/019-scheduled-jobs.md)).
To send your own message later instead, see
[scheduled messages](scheduled-messages.md).

## Creating and changing jobs

Jobs are created by asking a Wisp in its own conversation. The Wisp writes
self-contained instructions, because a run does not see the conversation, and
calls `schedule_job`. The approval card shows the title, the schedule in words
with the next run, the instructions, the skills it loads, and the tools it may
use. Approving it is the permission for those tools in every run of that job;
a Block rule still wins. Asking the Wisp to change a job (`update_job`) shows
a card again when the instructions change or tools are added. A Wisp also has
`list_jobs` and `cancel_job`, for its own conversation's jobs only.

Schedules are **once** at a time, **daily**, **weekly** on chosen weekdays, or
**monthly** on a day of the month (the last day when the month is shorter),
at a local time in the time zone the job was created in, even on a server in
another zone. Recurring jobs can end on a date or after a number of runs.
Nothing runs more than once a day. A Wisp can hold 20 jobs.

## Managing jobs

**Settings → Jobs** lists every Wisp's jobs, and a Wisp's **Jobs** settings
list its own, with the next run, the last run and its outcome, and the recent
runs. From there you can **pause**, **resume**, **run now**, and **delete** a
job. Changing what a job does or when it runs is done by asking the Wisp.

## How a run works

- A run uses the Wisp's model, system prompt, plugins, MCP servers,
  workspace, and container, plus the job's skills, but none of the
  conversation's history. It knows its saved state and when it last ran.
- No one is present, so nothing waits for an approval: the job's approved
  tools run, commands in the Wisp's container run as usual, and anything that
  would still ask is refused and the Wisp is told why.
- The run's final reply is its message. It appears in the conversation marked
  with its job, counts as unread, and notifies like a reply. It also enters
  the Wisp's context, so you can follow up on it. A run can finish without a
  message (`skip_delivery`, for "nothing new") and keep up to 16 KB of state
  for the next run (`save_job_state`).
- One run per job at a time, two runs at once per backend, and at most 15
  minutes per run.

## Missed runs and failures

Jobs run in the backend that owns the Wisp: around the clock on a
[Wisp server](remote-server.md), or while the desktop app runs. Runs missed
while it was stopped collapse into one run when it starts again.

A run that fails for a reason that may pass (provider, network, or rate
limits) is retried 5 and then 15 minutes later. After three failed
occurrences in a row the job pauses itself, and a notice in the conversation
says why. The last 50 runs of each job are kept, with their timing, outcome,
errors, and token usage.

Jobs are not available in [circles](circles.md). Wisps on
[Claude Code](models.md#claude-code) run jobs too, one turn each.
