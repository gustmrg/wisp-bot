# Application settings and status

**Settings** (application-level) has panels for **General**,
**Connections**, **Remote access**, **AI Model**, **Voice input**,
**Plugins**, **MCP servers**, **Jobs**, **Token usage**, **Storage**,
**Notifications**, **Shortcuts**, and **About**. Where they are covered
elsewhere:

- **Connections** and **Remote access**: [headless server](remote-server.md#connect-the-desktop-app)
  and [remote access to this computer](remote-server.md#remote-access-to-this-computer).
- **AI Model**: [AI models](models.md).
- **Plugins** and **MCP servers**: [plugins](plugins.md) and
  [remote MCP servers](mcp-servers.md).
- **Jobs**: [scheduled jobs](jobs.md).
- **Token usage**: [token usage](token-usage.md).

## First-run setup

Before the workspace opens, Wisp checks the minimum setup: a preferred name,
a global default model, and a saved API key for that model's provider. When
any of them is missing, a full-screen onboarding asks only for what is missing
and ends with a "You're all set" step. The check runs once per launch, so
changing settings later in a session does not interrupt it; the next launch
checks again.

Creating a Wisp also requires a usable model: either the global default with
a saved provider key, or a model chosen for that Wisp whose provider has a
saved key.

## General

- **Your profile** — preferred name, optional background, and response preferences. Saved locally in `user-profile.json` and shared with every Wisp (and its AI provider when chatting). Changes refresh existing Wisp context; busy Wisps apply the refresh after their current turn. Blank fields remove that profile context. The preferred name is required and also supplies the sidebar name and initials.
- **Application** — theme, Wisp colors, and launch at login. With **Wisp colors** off, replies, the send button, and the selected conversation keep the neutral look instead of each Wisp's color.
- **Wisp** — timezone and auto-review. Auto-review shows one Allow / Ask /
  Block choice for **Create files** and one for **Modify files**; turning
  auto-review off makes Wisp ask before every file change and disables the
  choices. These are the defaults for every Wisp: **Always allow** and
  **Always block** on an approval card, and the choices under **Without
  asking** in a Wisp's **Access** tab, apply to that Wisp only, as do MCP
  tools and plugins always allowed from a card. Integration blocks added from approval prompts are listed below them
  (see [security](security.md) for how rules are applied).

**Timezone** defaults to auto-detect, which follows this device. Every date
and time in the app is shown in it: message times, day dividers, the
conversation list, search results, scheduled messages and reports. Times are
stored in UTC, so changing it never alters history. The app also reports the
zone to the server it is connected to, which saves it in
`user-time-zone.json`. Wisps then see the user's local date and time with
each message, and daily context renewal and new scheduled messages use the
same zone. Until the app reports a zone, a server uses its own.

**Plugins** and **MCP servers** open each connection in place, inside the
settings dialog. Removing a connection or a provider API key asks for an
inline confirmation first.

Preferences are stored locally in the renderer.

## Voice input

The composer's main button records a message while there is nothing to send
(also with `Ctrl+Space`, which can be changed under **Shortcuts**). A
recording lasts at most five minutes and is transcribed by a cloud
speech-to-text provider: **Groq** (the default), **OpenAI**, or **Mistral**,
with the model and the **Language** you speak (or auto-detect) chosen here,
along with the microphone. **Send automatically** sends the message as soon as
it is transcribed; otherwise the transcript waits in the composer for review.

Each provider needs its API key. A key saved for that provider's chat models
in **AI Model** is used too; see [subscription sign-in](models.md#subscription-sign-in)
for how a voice key and a ChatGPT sign-in coexist. In the browser app, voice
input needs HTTPS.

### Fallback model

**Settings → Voice input → Fallback** works like the
[fallback model](models.md#fallback-models) in **AI Model**: **Fallback model**
is a model a recording goes to when the provider above cannot transcribe it:
it cannot be reached, takes longer than 30 seconds, is rate limited or down,
rejects its key, or has no credit left. Only models from providers with a
saved key are listed, and a fallback whose key is removed later is shown as
unavailable and skipped. A recording that is empty, too long, or that a
provider could not read is not sent to the fallback, since it would fail the
same way, and no provider gets the same recording twice.

When transcription fails, the composer keeps the recording: **Try again**
sends it again to the providers as they are set then, so a key saved or a
fallback chosen in the meantime is used without recording anew. Starting a new
recording or leaving the conversation drops the kept one.

## Storage

**Storage** measures the space each Wisp's and circle's workspace takes,
largest first, with its largest folders and files, and lets you browse a
workspace folder by folder. Selected files and folders can be removed after a
preview of what will go; a removal from `inbox/` warns that messages may refer
to those attachments. The same panel changes a workspace's size limit (as in
the Wisp's or circle's **Workspace** settings) and lists the archives of
deleted Wisps and circles, which can be deleted permanently. A workspace set
to **Unlimited** shows what it holds and the free space on its disk instead of
a share of its size, and the summary counts it apart from the allotted space;
see [security](security.md#tool-authorization) for how its disk limits it. Sizes are the
files' logical lengths, not the space allocated on disk.

## Shortcuts

**Shortcuts** lists the keyboard shortcuts: search (`Cmd/Ctrl+K`), collapse or
expand the sidebar (`Cmd/Ctrl+B`), send (`Enter`), new line (`Shift+Enter`),
schedule a message (`Cmd/Ctrl+Shift+Enter`), and cancel a voice recording
(`Esc`). The voice input shortcut can be changed or reset; it needs `Ctrl`,
`Alt`, or `Super` with another key, or a function key.

## Launch at login

Available only in packaged Linux releases (`.deb` and AppImage). The desktop
process creates or removes `$XDG_CONFIG_HOME/autostart/wisp-bot.desktop`,
falling back to `~/.config/autostart` when the variable is unset or relative.
It opens the normal application window when an XDG-compatible desktop session
starts. No administrator permissions are needed.

The toggle reads the registration when Settings opens and when the window
regains focus. The legacy renderer preference is ignored; it never recreates
a registration removed or disabled outside Wisp. macOS, Windows, and
development builds show a disabled toggle with an explanation.

AppImage registration uses the original `APPIMAGE` path, not the temporary
mounted executable. Keep the AppImage in a stable location. After moving or
renaming it, open the new file and enable Launch at login again to update the
registration. Disable this option before removing the application.

## Notifications

The **Notifications** panel contains the app-level **Notification sounds** toggle,
a volume slider (0–100%), and a Test button for each sound. In the desktop
app it also has **System notifications**, with a switch and a Test button per
event; see [below](#system-notifications).
Existing sound preferences are preserved. New settings default to full volume,
all three events enabled, and open-conversation muting off.

- **Response completed** — a rising chime when a Wisp finishes its turn.
- **Approval needed** — a falling chime when a Wisp awaits tool approval.
- **Execution error** — a lower falling chime when a Wisp's turn fails. Errors
  outside a turn, such as a rejected model change, stay silent.
- **Mute the open conversation** — skips sounds for the selected conversation
  while the app window is visible and focused; background conversations still notify.

All live sounds respect both the global sound toggle and the individual Wisp's
notification toggle. Failed or cancelled turns do not also play the completion
sound. Volume zero is silent. Test buttons preview sounds at the chosen volume,
even if that event is disabled, but are disabled when global sounds are off or
volume is zero. Settings are saved on this device; disabling sounds retains the
volume and event choices. There are no scheduled quiet hours.

### System notifications

The desktop app's main process shows native notifications and the Dock or
taskbar badge for the same events, and for a [job's](jobs.md) message, also
with every window closed while the app runs
([ADR 022](decisions/022-system-notifications.md)). The title is the Wisp's
name and the body the start of its reply, the approval's summary, or the
error. Clicking one opens that conversation. The conversation on screen is
skipped while the app has focus, and a Wisp whose notifications are off never
notifies. The badge counts unread conversations plus pending approvals. If
notifications never appear, they are turned off for Wisp in the system's
settings. The browser app has no system notifications.

## Updates (About)

Installed releases have explicit check, download, and restart-to-install
update steps. Checking runs only when you ask, and nothing downloads on its
own. The update feed is turned off in development ("Updates are available only
in an installed release").

- **Linux** (AppImage and `.deb`) downloads and installs updates in place. The
  `.deb` asks for the administrator password. See
  [installing on Linux](installing-on-linux.md).
- **Windows** downloads updates and installs them in place on restart. See
  [installing on Windows](installing-on-windows.md).
- **macOS** builds are ad-hoc signed rather than notarized, so they cannot
  install updates themselves. They show the new version and open the releases
  page instead. See [installing on macOS](installing-on-macos.md).

## Not connected yet

- Launch at login on macOS and Windows.
- System notifications in the browser app and on phones (Web Push, SWE-163).
