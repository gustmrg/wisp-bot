# ADR 039: Small approval cards on a phone

- Status: Accepted
- Date: 2026-10-30
- Decision owners: Wisp renderer
- Scope: How pending tool approvals are shown and answered in the mobile layout
- Related: [mobile layout](../mobile-layout.md#bottom-bar-and-approvals),
  [ADR 015](015-mobile-bottom-bar.md), [ADR 023](023-wisp-permissions.md)

## Context

A Wisp's parallel tool calls can ask for several approvals at once, and several
Wisps can ask at the same time. The Approvals screen and the chat stacked a
`ToolApprovalCard` for each, with its explanation and up to five buttons. The
list's "needs you" card already showed one approval in far less room.

Measured at 390x844 with one integration change, one command and one file change:

| | Height per card | Whole cards on screen |
|---|---|---|
| Approvals screen, full card | 201–382px | 1 of 3 |
| Chat, full card | 173–337px | 2 of 3 |
| The list's card, on either | 154–172px | 3 of 3 |
| The list's card with its buttons beside the text | 110px | 5 of 6, with the request cut off |

In the chat the problem was worse than the height. The view rests on the end of
the transcript, and "Allow all" sat above the first card, so it started out of
sight, further away with each approval. The person had to scroll up to find the
one button meant to save scrolling.

"Allow all" also did not say what it covered, and it never offered again an
answer that failed to reach the backend, as on a dropped connection.

How many approvals usually arrive at once was not measured. `tool-audit.jsonl`
holds that on each server. The decision does not depend on the number.

## Decision

**In the mobile layout, every pending approval is the list's small card, and
"Allow all" stays on screen.**

- `ApprovalSummary` is the list's card, shared by the list, the Approvals screen
  and a phone's chat: who asks, what for, the request in one or two lines, the
  time left, and Deny and Allow once. A job, a skill, a memory change or a Wisp
  change offers Review instead, as before.
- `ApprovalSheet` is where the rest lives: the whole `ToolApprovalCard`, with
  Always allow and Always block, and a way into the conversation when not
  already in it. Tapping a card opens it.
- "Allow all" leaves the scrolling content: above the bottom bar on the
  Approvals screen, and above the composer in the chat, on the desktop too.
- Its bar says what it covers: "2 commands, 1 file change". An answer that did
  not reach the backend is offered again.
- The desktop's chat keeps its full cards: it has the room, and the problem it
  shared was only where "Allow all" sat.

## Consequences

- Three approvals fit on a phone's screen with no scrolling. Six still scroll,
  with three on screen and "Allow all" always in reach.
- The rarer, lasting answers take one more tap, and sit away from the tap that
  answers once, which makes them harder to hit by mistake.
- A card's request is cut at two lines. Its sheet shows the whole of it.
- Going from the Approvals screen to a conversation takes two taps instead of one.

Leaving an approval unanswered needed no change. A pending approval lives in the
backend for 30 minutes and is denied when that runs out, so one answered and the
rest left behind keep their state wherever the person goes, on every device.

## Deferred

- A sheet that moves on to the next approval after answering one.
- Grouping approvals, if `tool-audit.jsonl` shows that ten or more at once is common.

## Decisions taken with the user

- Implement this design after reviewing the measurements and the alternatives.

## Rejected alternatives

- **Buttons beside the text.** The card shrinks to 110px, but the narrow column
  cuts off the request being approved. A command must be readable before Allow.
- **Grouping approvals into one line, such as "3 read tools".** Reads and
  searches never ask for approval, so that case does not exist, and grouping
  the rest would hide what each one does.
- **A queue, one at a time ("1 of 5").** It hides what else is waiting, and is
  slower for the common case of a few related requests.
- **A sheet holding the whole list.** It adds a layer on top of a screen that
  only lists approvals, and hides the conversation in the chat.
- **Deny all.** Stop already cancels what is pending in a conversation. Denying
  everything from the Approvals screen would stop unrelated Wisps with one tap.
- **A confirmation on Allow all.** With the cards on screen and the kinds stated,
  a second tap adds friction without adding information.
