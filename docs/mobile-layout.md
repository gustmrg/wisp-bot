# Responsive mobile layout

At viewport widths up to 760px the renderer shows one screen at a time: the
conversation list, an active chat, Wisp settings, or pending approvals. The list includes live
Unread and Active filters and a bottom navigation bar. Search, Wisp creation,
and application settings use full-screen dialogs with their existing backend
actions and focus management. Wider windows keep the desktop panels. The
Electron window can be resized down to 360px wide to use this layout locally.

## Bottom bar and Approvals

The bottom bar has Wisps, Approvals, and Settings (see
[ADR 015](decisions/015-mobile-bottom-bar.md)). Wisps shows how many
conversations are unread and Approvals how many tool approvals are pending.
The Approvals screen lists every pending approval, the latest first, each with
the conversation it came from. An approval answered there or in the chat
leaves both.

## Conversation list

The list reads like a messaging app. The latest activity comes first, while
the desktop sidebar keeps the creation order. Each row shows the Wisp's
avatar with its state, the name, the time of the last activity, and one line
that is either the last message or what needs attention: "Working…",
"Waiting for your approval", or "The last reply failed". An unread
conversation has a badge beside that line and a stronger time. The badge counts
the unread replies and questions, up to "99+". A conversation turns unread on
every device when a Wisp finishes a reply, fails one, or asks a question, each
adding one to the count, and turns read when someone opens it, or when the
reply arrives while it is on screen. A hairline
separates the rows, starting after the avatar.

## Settings

The Settings overview starts with a profile card (see
[ADR 014](decisions/014-mobile-identity.md)). One row shows the person's name
and opens General. The other shows where the Wisps run, the connection state,
and, in the browser app, this device's name, and opens Connections. Below the
card, each section is a card with an icon, a title, and a one-line
description, grouped by theme.

## Draft and input behavior

Returning to the list, opening settings, or resizing the window retains the
current conversation draft. On mobile, Enter inserts a newline; the send button
sends the message. The layout respects safe areas and follows the visual
viewport height when the software keyboard opens. It does not focus the
composer merely because a conversation was opened.

## Scope

The mobile layout applies wherever the renderer runs in a narrow viewport:

- **Desktop app.** The Electron window switches to it below 761px wide.
- **Browser app.** A Wisp server serves the same app to browsers through a web
  transport instead of the Electron bridge. A browser pairs once with a
  one-time code from `wispctl pair` and then uses the Wisps on that server.
  On a phone it can be installed to the home screen and opens full screen.
  See [Use Wisp in a browser or on your phone](remote-server.md#use-wisp-in-a-browser-or-on-your-phone)
  and [Pair devices](remote-server.md#pair-devices).

Opening the Vite dev server URL in a browser without either still shows the
bridge-required screen.

The browser app's service worker caches only the app's files, so it opens
without a network and reconnects when it can. Conversations, settings, and
API responses are never cached: reading or sending messages offline is not
supported.
