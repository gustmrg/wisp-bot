# Responsive mobile layout

On a phone, whichever way it is held, and at viewport widths up to 760px, the
renderer shows one screen at a time: the conversation list, an active chat, Wisp settings, or pending approvals. The list includes live
Unread and Active filters and a bottom navigation bar. Search, Wisp creation,
and application settings use full-screen dialogs with their existing backend
actions and focus management. Wider windows and tablets keep the desktop panels. The
Electron window can be resized down to 360px wide to use this layout locally.

A phone stays in this layout on its side, without the sidebar, and the keyboard
does not change the layout. A device counts as a phone when a side of its
screen is shorter than 600px; see
[ADR 038](decisions/038-phone-layout-in-any-orientation.md).

## Each Wisp's color

Each Wisp's color marks what belongs to it. The color is the one chosen for
the Wisp, or one derived from its name:

- **Avatars.** A Wisp sits on a soft disc of its color. A ring around it says
  what it is doing: an arc going round while it works, amber while it waits
  for an approval, and red after a failed reply.
- **The list.** The Wisp's role, its unread count, and the line saying what it
  is doing ("Searching the web…") take its color.
- **Its conversation.** The Wisp's light spills from the top of the chat. Its
  replies and its typing bubble are tinted with its color, and the composer's
  main button (voice or send) is filled with it. The person's own messages are
  neutral so the Wisp's color stands out. Under the name, the header shows the
  Wisp's role, or what it is doing ("Searching the web", or "Working…" when
  that is not known), "Waiting for your approval", or "Couldn't reply". A Wisp with nothing said yet introduces itself with the first
  paragraph of its soul. While it works, the tools it has used in this turn
  show as a trail of steps, each checked, failed, or still running. A running
  step says what the Wisp is doing, in the same words as the header. The typing
  bubble shows while the Wisp works, with no words beside it, and goes away
  while the Wisp waits for an approval. A tool is always named in words, never
  by its identifier.
- **Circles.** Each run of replies is named by the Wisp that wrote it and
  tinted with that Wisp's color.

## Bottom bar and Approvals

The bottom bar has Wisps, Approvals, and Settings (see
[ADR 015](decisions/015-mobile-bottom-bar.md)). It floats as a pill near the
bottom edge, at the same distance on every tab, even while the conversation
list scrolls under it; only the current tab shows its name. Wisps shows how many
conversations are unread and Approvals how many tool approvals are pending.
The Approvals screen lists every pending approval, the latest first, each in a
small card: who asks, what it wants to do, the request in one or two lines, and
the time left. Deny and Allow once answer it there. A job or a skill must be
read in full first, so it offers Review instead. Tapping a card opens a sheet
from the bottom with the whole request, every answer, including Always allow and
Always block, and a way into the conversation. A phone's chat shows the same
cards, and its sheet has no way into the conversation, which is already open.

With more than one waiting, a bar says how many there are and of what kinds,
such as "2 commands, 1 file change", and "Allow all N once" answers every one a
tap may answer; jobs and skills still need their own review. The bar stays on
screen while the rest scroll: above the bottom bar on the Approvals screen, and
above the composer in the chat, on the desktop too. An approval answered there,
from the list, or in the chat leaves all of them. An approval left unanswered
keeps waiting wherever the person goes, until it expires and counts as denied.
See [ADR 039](decisions/039-small-approval-cards-on-a-phone.md).

## Conversation list

The list starts with a greeting for the time of day, the title Wisps, and
buttons for search and creating a Wisp. Under them, a row of every Wisp, in
its color, shows at a glance which are waiting for the person, working,
failed, or unread, in that order; tapping one opens its conversation. The
light at the top of the list comes from the busiest Wisps' colors.

**Approving from the list.** When a Wisp is waiting for an approval, the one
asked last sits above the conversations: who asks, what it wants to do, the
request in one or two lines, and the time left. Deny and Allow once answer it
there. A job or a skill must be read in full first, so it offers Review
instead. Tapping the card opens a sheet from the bottom with the whole
request and every answer the chat offers, including Always allow and Always
block, and a way into the conversation. When more are waiting, "N more
waiting" opens the Approvals tab.

The list reads like a messaging app. The latest activity comes first, on the
phone and on the desktop sidebar alike. Each row shows the Wisp's
avatar with its state, the name, the time of the last activity, and one line
that is either the last message or what needs attention: "Working…",
"Waiting for your approval", or "The last reply failed". An unread
conversation has a badge beside that line and a stronger time. The badge counts
the unread replies and questions, up to "99+". A conversation turns unread on
every device when a Wisp finishes a reply, fails one, or asks a question, each
adding one to the count, and turns read when someone opens it, or when the
reply arrives while it is on screen. A hairline
separates the rows, starting after the avatar.

Pinned conversations come first, each marked with a pin, and keep that place
on every device. A long press on a row opens its menu: Pin or Unpin, Mute
notifications or Turn on notifications, and Mark as read or Mark as unread.
The same menu opens with a right click on the desktop and with the keyboard's
menu key or Shift+F10 on a focused row; the arrow keys move through it and
Escape closes it. A conversation marked unread while it is open stays unread
until it is chosen again.

## A Wisp's profile

On a phone, the "…" in a Wisp's conversation opens its profile: the Wisp
large in its own light, its name, role, and soul, a switch for its
notifications, and a list of what it knows and does (Memory, Skills,
Workspace, Commands, Jobs). Chat goes back to the conversation; Edit, Model,
Access, Usage, and each row of the list open one page of its settings, titled,
with a way back to the profile. Edit only edits the appearance, name, role,
and soul. Share as template and Delete end the profile. A circle's "…" still
opens its settings.

## Settings

The Settings overview starts with a profile card (see
[ADR 014](decisions/014-mobile-identity.md)). One row shows the person's name
and opens General. The other shows where the Wisps run, the connection state,
and, in the browser app, this device's name, and opens Connections. Under it,
a row of the Wisps in their colors, with how many there are, leads back to
the list. Below, the sections are grouped by theme; each has an icon, a
title, and a one-line description, and the sections of a group share one
card.

## Draft and input behavior

Returning to the list, opening settings, or resizing the window retains the
current conversation draft. On mobile, Enter inserts a newline; the send button
sends the message.

The composer is a pill-shaped field between a + button and one main button.
The main button is voice input while there is nothing to send, send once there
is a draft, and stop while the Wisp works with nothing typed; typing during a
reply queues the draft, and stop moves into the field. The + opens Attach
files and Schedule send. A time picked there stays on the draft as a chip until
the main button, now a calendar, schedules it. A long press on the send button
(a right click on the desktop) offers the suggested times and schedules the
draft right away. The layout respects safe areas and follows the visual
viewport height when the software keyboard opens. It does not focus the
composer merely because a conversation was opened.

## On the desktop

The desktop shares the Wisps' colors, state rings, the chat's light, the
step trail, and the introduction of a new Wisp. Its sidebar lists only the
conversations, without the row of Wisps, and creates a Wisp from the button
beside Search. It lists no approvals: a Wisp waiting for one is marked in its
row, and the approval is answered in the conversation. The conversation reads as one centered
column. A gear button opens a side panel on the Wisp's settings; who the Wisp
is sits in the panel's header, as tall as the conversation's own top bar, and
General, Model, Access, and Usage tabs carry the rest. A circle's gear opens
its settings directly, in General, Members, Workspace, and Usage tabs; its
Usage counts only what each member used in that circle.

In the dark theme a near-black Wisp lends the interface a silver tint instead
of its own color, so its glow and accents still show on the dark background.

## Scope

The mobile layout applies wherever the renderer runs in a narrow viewport or on
a phone's screen:

- **Desktop app.** The Electron window switches to it below 761px wide.
- **Browser app.** A Wisp server serves the same app to browsers through a web
  transport instead of the Electron bridge. A browser pairs once with a
  one-time code from `wispctl pair` and then uses the Wisps on that server.
  On a phone it can be installed to the home screen and opens full screen.
  See [Use Wisp in a browser or on your phone](remote-server.md#use-wisp-in-a-browser-or-on-your-phone)
  and [Pair devices](remote-server.md#pair-devices). Phones use the mobile
  layout whichever way they are held.

Opening the Vite dev server URL in a browser without either still shows the
bridge-required screen.

The browser app's service worker caches only the app's files, so it opens
without a network and reconnects when it can. Conversations, settings, and
API responses are never cached: reading or sending messages offline is not
supported.
