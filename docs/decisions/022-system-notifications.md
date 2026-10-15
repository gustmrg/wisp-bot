# ADR 022: Native notifications from the desktop app's main process

- Status: Accepted
- Date: 2026-10-15
- Decision owners: Wisp desktop app
- Scope: Telling the person a Wisp finished, needs approval, or failed when Wisp is not in front of them
- Related: [ADR 009](009-headless-server.md), [ADR 018](018-native-mobile-app.md)

## Context

Wisp said a Wisp had finished, needed approval, or failed only with a sound
synthesized in the renderer (`src/hooks/use-notification-sounds.ts`) and
badges inside the app. Both need the renderer to be running and to be looked
at. With the window minimized, behind other windows, or closed while the app
keeps running (macOS, or the tray while remote access is on), nothing told
the person.

The app is always a client: its Wisps run in a server it starts as a child
process, or on a server over SSH. The main process relays every event that
server pushes to the windows (`broadcast` in `electron/main.ts`), whether or
not any window is open.

## Decision

The **main process** shows native notifications and sets the Dock or
taskbar badge, from what it relays. `SystemNotifier`
(`electron/system-notifications.ts`) sees every pushed payload:

- **Events and rules** are those of the notification sounds: a turn that ends
  without failing or being stopped, an approval request, a failed turn, and a
  job's message. Only live transitions notify, never a snapshot. Only a
  Wisp's own conversation notifies, and only while its notifications are on.
  The conversation on screen is skipped while a window of the app has focus.
- **Content:** the title is the Wisp's name, the body the start of what it
  wrote (without Markdown), the approval's summary, or the error's message.
- **Names and counts** come from the active connection's conversation state.
  It is loaded when the connection changes, and again for a conversation
  it does not know yet. After that, conversation changes keep it up to date.
- **The badge** counts conversations with unread messages plus pending
  approvals, as the app's own counters do.
- **Clicking** a notification shows the app on that conversation. If no
  window is open, it opens one, and the new window takes the waiting target
  once (`takeNotificationTarget`).
- **Settings** stay in the renderer's preferences, next to the sound
  settings, with their own switch and test per event. The renderer sends
  them to the main process, along with the conversation on screen
  (`window.wisp.systemNotifications`). The main process keeps the last ones
  it was sent, so a closed window does not change what notifies.

With a window open, notifications are silent: the renderer plays its own
sounds. Without one, the system's sound plays.

## Per platform

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Notifications | Notification Center; the system asks for permission the first time | Toast notifications; the app sets its AppUserModelID (`com.gustavomiranda.wispbot`, the executable in development) | Through the desktop's notification daemon (libnotify); whether clicks reach the app depends on the daemon |
| Badge | Count on the Dock icon | Red dot overlaid on the taskbar button; it has no count | Launcher count where the desktop supports it (Unity, KDE); otherwise none |
| Approval needs attention | Dock icon bounces once | Taskbar button flashes until the window is focused | Window flashes where the window manager supports it |

If notifications never show, the system has them off for Wisp: System
Settings → Notifications on macOS, Settings → System → Notifications on
Windows, and the desktop's notification settings on Linux.

## Consequences

- Notifications keep coming with every window closed, as long as the app
  runs, for the server the app is connected to, local or remote.
- The main process now keeps a small summary of conversations (names, unread
  flags, pending approvals) per connection, separate from the renderer's.
- Sounds still need the renderer. The two channels are configured apart.

## Not done here

The browser app (and the home-screen PWA on phones) has no native
notifications: `window.wisp.systemNotifications` is absent there, and its
settings hide the section. Web Push would need the server to keep VAPID keys
and subscriptions per paired device, and iOS allows it only for installed
PWAs. That is tracked in SWE-163.
