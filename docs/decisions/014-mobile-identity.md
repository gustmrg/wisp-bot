# ADR 014: Who and where on mobile

- Status: Accepted
- Date: 2026-10-09
- Decision owners: Wisp renderer
- Scope: Where the mobile layout shows the person, the server their Wisps run on, and this device
- Related: [mobile layout](../mobile-layout.md), [Wisp server](../remote-server.md), [ADR 009](009-headless-server.md)

## Context

On the desktop, the bottom of the sidebar shows the person's initials and
name, and opens Settings. The mobile layout (760px wide or less) has no
sidebar: the list's bottom bar has Wisps and Settings, and the Settings
overview starts with a profile card showing the initials, the name, and the
placeholder line "Your workspace".

What the app can say about who and where:

- **The person.** `CurrentUser`: a display name and initials. There is no
  avatar image. The name is edited in Settings › General.
- **No workspace.** "Workspace" is only the renderer's word for its state. The
  thing a person can have several of, and switch between, is a
  **connection**: this computer, or a Wisp server reached over SSH or a URL.
  Only the desktop app can switch (`ConnectionsView.canManage`); the browser
  app always uses the server that served it.
- **Connection state.** `ConnectionStatus.phase`. A reconnect already shows a
  banner above the whole app; connecting and pairing take over the screen.
- **This device.** The browser app pairs under a name made from the user
  agent, such as "Chrome on iPhone" (`browserDeviceName`), and signs out in
  Settings › Connections with "Sign out of this browser".
- **Server version.** The desktop app knows the version of a remote server
  and shows a dismissible banner when it differs from the app. The browser app
  is served by the server, so the two always match.

## Decision

**Settings holds the identity; the conversation list does not.** The
profile card at the top of the Settings overview becomes the one place for
who and where. The conversation list header gets no avatar.

```
 Conversation list            Settings overview
┌──────────────────────┐     ┌──────────────────────────────┐
│ Wisps         🔍  ＋ │     │ ✕          Settings          │
│ [All] Unread  Active │     │ ┌──────────────────────────┐ │
│                      │     │ │ (AL)  Alex             › │ │ → General
│ ( ) Wisp one   12:04 │     │ ├──────────────────────────┤ │
│ ( ) Wisp two   Mon   │     │ │ ● home-server          › │ │ → Connections
│ …                    │     │ │   Chrome on iPhone       │ │
│                      │     │ └──────────────────────────┘ │
├──────────────────────┤     │ ⚙ General                  › │
│  💬 Wisps  ⚙ Settings│     │ …                            │
└──────────────────────┘     └──────────────────────────────┘
```

The card has two rows, each a button of at least 56px:

| Row | Shows | Opens |
|---|---|---|
| Person | Initials in the profile avatar; display name, or "Your profile" before one is set | Settings › General, where the name is edited |
| Connection | Status dot and name of the connection: "This computer" or the server's name. Browser app only: a second line with this device's name. Desktop app only: a warning badge while the server version differs from the app's | Settings › Connections |

The status dot follows `ConnectionStatus.phase`: connected or local is
green, reconnecting is amber. Other phases never reach the overview, because
the connection gate covers the app. The dot has a text label for screen
readers ("Connected", "Reconnecting").

What stays where it is:

- **Sign out of this browser** stays in Settings › Connections, behind its
  confirmation. It is destructive, so it does not go on the card.
- **Switching connections** stays in Settings › Connections (desktop only).
  There is no switcher on the card: switching reloads everything and is rare
  on a narrow window.
- **Versions** stay in Settings › About. The card shows only the mismatch
  badge, which outlives a dismissed banner.
- The "Your workspace" line goes away.

The list shows nothing about the person or the server: no name, no host,
no device. A reconnect is already visible through the app-wide banner.

## Consequences

- One tap from the list (the Settings tab) reaches who and where. That is
  the same as now, and the list header keeps its space for search and
  creating a Wisp.
- Server names, which can be a host name or a private URL, appear only on
  Settings, never on the screen most likely to be seen over a shoulder.
- The card's connection row needs the `ConnectionsView` that
  `ActiveConnectionContext` already provides; the device name must be
  exposed from the browser API to the renderer, as it is only passed to
  pairing today.
- The card is the first card of the Settings overview, so it is built
  together with the Settings cards of SWE-121 and uses the same row
  component.

## Alternatives considered

- **Avatar in the list header** that opens Settings, as in Telegram:
  rejected for now, as it duplicates the Settings tab one tap away and takes
  header space. Revisit if SWE-122 moves Settings out of the bottom bar
  (for example into "More"); the header avatar then becomes the way in.
- **Both a header avatar and the Settings card:** rejected for the same
  reason; two entry points to the same screen.
- **Connection name in the list header** (like a workspace name in Slack):
  rejected. It shows the server on the list, and most people use one
  connection, so it would say the same thing every time.
- **Sign out on the card:** rejected. Destructive actions live inside their
  section, after an explanation.
