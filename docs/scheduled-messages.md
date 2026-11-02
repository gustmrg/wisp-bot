# Queued and scheduled messages

## Messages sent while a Wisp works

Typing while a Wisp is still replying queues the message instead of
interrupting. Waiting messages are listed above the composer, can be edited
or removed, and are sent in order as the Wisp becomes free; each joins the
transcript only when the Wisp takes it. A Wisp can have 8 messages waiting.

Some runtimes can read a message during the running turn: it is then marked
**Follow-up** ("Read before the next step"), and the Wisp reads it before its
next step instead of after it finishes. A follow-up still waiting when the
turn ends is sent like any other message.

In a [circle](circles.md#who-answers), a message waits only for the Wisp it goes
to, so it can pass a message that waits for a busy Wisp.

## Scheduled messages

A scheduled message is your own message, sent to a Wisp later as if you typed
it then. To schedule the current draft:

- open **+ → Schedule send** and pick a time; it stays on the draft as a chip
  until the main button, now a calendar, schedules it; or
- long-press the send button (right-click on the desktop), or press
  `Cmd/Ctrl+Shift+Enter`, for the suggested times: **In 1 hour**, **Tomorrow
  morning**, and **Monday morning** (mornings are 09:00), or a custom time.

Scheduled messages are listed with the waiting ones above the composer, where
they can be edited, cancelled, or sent now. Times follow the
[time zone](application-settings.md#general) in Settings, also on a server in
another zone. A Wisp can hold 50 scheduled messages.

The backend sends them whether or not any app is connected, and sends those
that came due while it was stopped as soon as it starts. A message is taken
off the schedule just before it is sent, so a crash can lose a send but never
repeat one. A message for a busy Wisp joins its queue; one for a
[circle](circles.md) is routed by its mentions when the circle takes it.

Scheduled messages are sent once. For work a Wisp should repeat on its own,
ask it for a [scheduled job](jobs.md).
