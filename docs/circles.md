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

## Who answers

- A message that mentions members (`@Atlas`) goes to them, in the order they
  are first mentioned. The composer completes `@` from the circle's members.
  Names match without regard to case, and the longest name wins, so `@Ada`
  never matches `@Adam`.
- Any other message goes to the circle's **lead**, its first member. A small
  crown marks the lead on its avatar wherever its replies appear, after its
  name under the circle's name, and beside it in the **Members** list. A
  circle with one member shows no crown.
- Wisps answer one at a time. Each reply finishes before the next Wisp
  starts, and each Wisp sees the replies before its own, labeled with their
  authors. Every reply shows its author's avatar and name, in its color, and
  the activity line names the Wisp working.
- A Wisp can hand the task to another member by mentioning it in its reply.
  One message from you allows at most three handoffs; then the circle waits
  for you. A Wisp cannot hand off to itself or to a Wisp outside the circle,
  and a Wisp whose turn already failed for your message is skipped.
- **Stop** stops the current turn and drops the remaining ones. A message
  sent while the circle works waits for the round to end, and queued and
  [scheduled messages](scheduled-messages.md) are routed the same way when
  the circle takes them.
- A member that fails, or has no usable model, gets a failed reply with the
  reason, and the next Wisp still answers.

## What a Wisp can do in a circle

Each member uses its own plugin and MCP grants and its own permissions, so
approval cards say which Wisp is asking. Its context policy and memory apply
as in its own conversation.

The circle has one **shared workspace** that every member reads and writes;
attached files go to its `inbox/` folder. Its size limit belongs to the
circle and is changed in its **Workspace** tab or in **Settings → Storage**.
Deleting the circle archives that workspace.

In a circle, Wisps cannot run commands (their containers mount only their
own workspaces) and cannot manage [jobs](jobs.md), which deliver to a Wisp's
own conversation.

## Members and usage

Removing a member forgets that Wisp's history in the circle; adding it again
starts a new session. A circle's **Usage** tab counts only what each member
used in that circle, while each Wisp's own usage and the
[token usage](token-usage.md) dashboard keep counting per Wisp.
