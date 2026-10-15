---
title: Jobs and scheduled messages
summary: Tasks a Wisp runs on a schedule in the background (once, daily, weekly, monthly), how to create, approve, pause, run now or delete them, and how they differ from scheduled messages.
---
# Jobs and scheduled messages

## Jobs

A job is a task a Wisp runs on its own on a schedule, such as "every morning,
look for new job openings and send me what you find". Each run works in the
background and only its result arrives in the conversation; a run with
nothing to report can stay silent.

- **Create or change** — ask the Wisp in its conversation; there is no form.
  It proposes the title, schedule, instructions, skills and tools, and you
  approve them in a card. Changing the instructions or adding tools asks again.
- **Schedules** — once, daily, weekly on chosen days, or monthly, at a time
  in your timezone, with an optional end. A job runs at most once a day.
- **Manage** — [Jobs](wisp://settings/jobs) lists every Wisp's jobs and their
  runs, with **Run now**, **Pause**, **Resume** and delete. A Wisp's
  [Jobs](wisp://wisp/jobs) settings show its own jobs.

Runs have no one to ask, so they can use only the tools approved with the
job. A job that fails several times in a row is paused.

## Scheduled messages

To send one message later, use **Schedule send** in the composer (see the
*Conversations and the composer* topic). Unlike a job, it is a normal message
in the conversation, sent at the chosen time.
