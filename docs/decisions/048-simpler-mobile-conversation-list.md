# ADR 048: A simpler mobile conversation list

- Status: Accepted
- Date: 2026-11-18
- Decision owners: Wisp renderer
- Scope: What the mobile conversation list shows above the conversations
- Related: [mobile layout](../mobile-layout.md#conversation-list),
  [ADR 015](015-mobile-bottom-bar.md),
  [ADR 039](039-small-approval-cards-on-a-phone.md), SWE-332

## Context

The mobile list stacked four blocks above the first conversation: a greeting
for the time of day with the title Wisps, a row of every Wisp with its state,
the "needs you" card while an approval waited (154–172px, measured for
[ADR 039](039-small-approval-cards-on-a-phone.md)), and the filters.

Measured in the built app at 375x667 with seven Wisps and no approval, the
first conversation started at 259px and four rows fit above the bottom bar.
With the card, the list started near the middle of the screen.

Most of these blocks repeated something already on screen:

- **The Wisps row** showed the same avatars and state rings as the rows below
  it, and left circles out. The list already puts the latest activity first.
- **The "needs you" card** answered one approval. The Approvals tab, with its
  badge, answers all of them, and the row of a waiting conversation already
  says "Waiting for your approval".
- **The greeting** said nothing about the conversations.

## Decision

**The conversations follow the title and the filters directly.**

- The Wisps row goes, and with it the **Wisps row** setting in
  **Settings → General**.
- The "needs you" card becomes one line: "Atlas is waiting for your
  approval", or "3 approvals waiting". Tapping it opens the Approvals tab.
- The greeting goes. The title Wisps stays, with search and create beside it.
- The All filter drops its count. Unread keeps its count.
- Tapping **Wisps** in the bottom bar while on the list goes back to All and
  scrolls to the top, as tabs do in messaging apps.

The desktop sidebar is unchanged.

## Consequences

- At 375x667 the first conversation starts at 130px instead of 259px, and six
  rows fit instead of four. While approvals wait, the line takes 56px instead
  of the card's 154–172px.
- Answering an approval from the list takes one more tap: the line, then
  Allow once on the Approvals tab.
- A saved `wispsRow` preference is ignored. Preferences are normalized field by
  field, so no store change is needed.

## Decisions taken with the user

- Remove the Wisps row, rather than show only the Wisps that need attention.
- Replace the "needs you" card with a line that opens the Approvals tab.
- Remove the greeting, rather than add a large title that shrinks on scroll.

## Rejected alternatives

- **A row of only the Wisps that need attention.** Smaller, but it still
  repeats the rows that sort those Wisps to the top, and it moves the list
  each time a Wisp starts or stops working.
- **A large title that shrinks into a sticky header on scroll.** It keeps the
  search and create buttons in reach on a long list, but adds scroll handling
  for a title of one word.
