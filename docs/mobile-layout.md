# Responsive mobile layout

At viewport widths up to 760px the renderer shows one screen at a time: the
conversation list, an active chat, or Wisp settings. The list includes live
Unread and Active filters and a bottom navigation bar. Search, Wisp creation,
and application settings use full-screen dialogs with their existing backend
actions and focus management. Wider windows keep the desktop panels. The
Electron window can be resized down to 360px wide to use this layout locally.

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

This implements the mobile **renderer layout**. The app still requires the Electron bridge: opening the Vite
URL in a standalone mobile browser continues to show the bridge-required
screen. Remote access, web authentication, a PWA manifest, and offline support
require a separate web transport implementation; no desktop security checks are
bypassed.
