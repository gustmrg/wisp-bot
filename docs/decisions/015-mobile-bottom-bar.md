# ADR 015: Mobile bottom bar

- Status: Accepted
- Date: 2026-10-09
- Decision owners: Wisp renderer
- Scope: Which destinations the mobile layout's bottom bar holds
- Related: [mobile layout](../mobile-layout.md), [ADR 014](014-mobile-identity.md)

## Context

The mobile layout (760px wide or less) has a bottom bar with two items, Wisps
and Settings. A bar fits three to five. The candidates, and what the app has
for each today:

| Candidate | What exists | On a phone |
|---|---|---|
| Approvals | Pending tool approvals for every conversation are already in the renderer (`workspace.approvals`). Each is answered in its chat with `ToolApprovalCard`, which needs only the request and the Wisp's name. The list marks a chat waiting for approval. | Frequent, and urgent: a Wisp is stopped until someone answers, and an approval expires. The main reason to pick up the phone. |
| Activity | No event log. Unread messages already have the Unread filter. | Would need a new backend feed. |
| Token usage | A Settings section. | Rare; a look once in a while. |
| Search | A field at the top of the list, opening a full-screen dialog. | Already one tap from the list. |
| Create Wisp | A floating button on the list. | Rare after the first few. |
| Server and devices | The Settings profile card (ADR 014) shows the connection and this device. The device list exists only in `wispctl devices`. | Rare; needs a device UI first. |

## Decision

**Three items: Wisps, Approvals, Settings.** No "More" menu.

```
┌────────────────────────────────────┐
│ Conversations                      │
│ [ Search conversations           ] │
│ (All 4) (Unread 1) (Active)        │
│                                    │
│ ( ) Atlas                  12:04   │
│ (!) Scout       Needs approval     │
│ …                              [+] │
├────────────────────────────────────┤
│  Wisps (1)  Approvals (2) Settings │
└────────────────────────────────────┘
```

In the bar, (1) is the unread badge and (2) the approvals badge.

- **Wisps**: unchanged, plus a badge with the number of unread
  conversations, so it is visible from the other tabs.
- **Approvals**: a screen listing every pending approval, newest first, each
  a `ToolApprovalCard` with the Wisp's name and a link to its conversation.
  The tab's badge counts pending approvals and uses the warning color, as
  the list does for a waiting chat. With none, the tab stays, without a
  badge, and the screen says nothing is waiting. The tab is always there so
  the bar does not move under the thumb.
- **Settings**: unchanged. It keeps who and where (ADR 014), Token usage,
  and Connections.

Search and Create Wisp stay on the list, where they are already one tap
away. Activity waits for a reason to build a feed; Unread covers messages.

## Consequences

- One implementation issue: the Approvals tab and screen, and the two
  badges. No backend change: approvals and unread state are already in the
  renderer, and answering reuses the chat's approval call.
- An approval can be answered from either the Approvals screen or the chat,
  so both read the same state and a decision in one removes it from the
  other.
- Settings stays in the bar, so the decision in ADR 014 not to put an avatar
  in the list header holds.
- The desktop layout is unchanged.

## Alternatives considered

- **Five items with a central Create button**: rejected. Creating a Wisp is
  rare, and the list already has the button; a center slot would push
  Approvals and Settings to the edges for an action used a few times.
- **An "Approvals" filter on the list** instead of a tab: cheaper, but still
  one chat at a time, and hidden while in a chat or in Settings. The badge on
  a tab is visible from everywhere.
- **Activity tab**: rejected for now. It needs an event log on the server,
  and most of its value (new messages) is the Unread filter.
- **"More" with Usage, Search, and Devices**: rejected. Each already has a
  place one tap away, and a "More" tab with three rare items costs a slot.
