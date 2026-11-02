# Circles

A circle is a conversation between you and several of your Wisps. Each Wisp
in it keeps its own soul, skills, memory, model, plugins, and permissions,
on Pi or on Claude Code ([ADR 011](decisions/011-circles.md)).

## Creating a circle

The create dialog (the button beside Search) creates a Wisp or a circle. A
circle has a name, a description of what it works on, which its Wisps read,
its members, and a lead. A circle gathers Wisps you already have, so create
a Wisp first.

A circle's gear (or "…" on a phone) opens its settings in **General** (name,
label, description, notifications), **Members** (members and lead),
**Workspace**, and **Usage** tabs.

## An empty circle

Before the first message, a circle shows its members' avatars, its name, its
description, and suggested first messages that send when tapped. They ask
what the team can do, mention a member other than the lead, ask where to start
when the circle has a description, and ask to split a task between members.
A circle with one member offers only what fits one Wisp.

## Who answers

- A message that mentions members (`@Atlas`) goes to them, in the order they
  are first mentioned. The composer completes `@` from the circle's members.
  Names match without regard to case, and the longest name wins, so `@Ada`
  never matches `@Adam`.
- Any other message goes to the circle's **lead**, its first member. A small
  crown marks the lead after its name under the circle's name, on its avatar
  in an empty circle, and beside it in the **Members** list. A circle with
  one member shows no crown.
- A circle can let a [decision model](models.md#decision-model) choose instead.
  In its **Members** tab, **Without a mention, who answers** is **Lead** by
  default; **Decision model** stays disabled until one is chosen in
  **Settings → AI Model**. The model reads the message, the circle's recent
  messages, and each member's name, role, and the start of its soul, and the
  member it is sure of answers. That reply says **Chosen automatically**. When
  it is not sure, takes over 3 seconds, or fails, the lead answers, so a
  message is never lost or held up by it. Mentions and handoffs never go through
  the model.
- The Wisps a message goes to answer it one after another. Each reply finishes
  before the next Wisp starts, and each Wisp sees the replies before its own,
  labeled with their authors. Every reply shows its author's avatar and name,
  in its color, and the activity line names the Wisps working.
- Different Wisps can work at the same time
  ([ADR 042](decisions/042-wisps-working-at-the-same-time.md)). While one works,
  a message to another that is free is answered right away, and a Wisp that
  hands its task over is free for the next message. Each Wisp answers one
  message at a time, so a message to a busy Wisp waits above the composer, and
  a message that mentions no one waits for the lead. When a
  [decision model](models.md#decision-model) chooses, it chooses among the
  Wisps that are free, and one free Wisp simply answers, marked **Chosen
  automatically**. A Wisp that finishes says so in its own reply.
- A Wisp can hand the task to another member by mentioning it in its reply.
  Wisps are told to do this only when the task is another member's role and
  they cannot do it well themselves.
  One message from you allows at most three handoffs; then the circle waits
  for you. A Wisp cannot hand off to itself or to a Wisp outside the circle,
  and a Wisp whose turn already failed for your message is skipped.
- **Stop** stops every Wisp working and drops the turns still to come. Messages
  waiting above the composer are not dropped: they start once their Wisp is
  free. Queued and [scheduled messages](scheduled-messages.md) are routed the
  same way when the circle takes them.
- A member that fails, or has no usable model, gets a failed reply with the
  reason, and the next Wisp still answers.

## What a Wisp can do in a circle

Each member uses its own plugin and MCP grants and its own permissions, so
approval cards say which Wisp is asking. Its context policy and memory apply
as in its own conversation.

The circle has one **shared workspace** that every member reads and writes,
possibly at the same time, so a file can change while a Wisp works; attached
files go to its `inbox/` folder. Its size limit belongs to the
circle and is changed in its **Workspace** tab or in **Settings → Storage**.
Deleting the circle archives that workspace.

In a circle, Wisps cannot run commands (their containers mount only their
own workspaces) and cannot manage [jobs](jobs.md), which deliver to a Wisp's
own conversation.

## Members and usage

Removing a member forgets that Wisp's history in the circle; adding it again
starts a new session. A circle's **Usage** tab counts only what each member
used in that circle, while each Wisp's own usage and the
[token usage](token-usage.md) dashboard keep counting per Wisp. What the
decision model used is a **Decision model** row of its own in both.
