# Application settings and status

**Settings** (application-level) groups its panels the same way on the desktop
and on a phone:

- **Account and server**: **General**, **Connections**, **Remote access**
- **Wisps**: **AI Model**, **Voice input**, **Plugins**, **MCP servers**, **Permissions**, **Jobs**
- **Notifications and input**: **Notifications**, **Shortcuts**
- **Storage and data**: **Token usage**, **Storage**
- **App**: **About**

Where they are covered elsewhere:

- **Connections** and **Remote access**: [headless server](remote-server.md#connect-the-desktop-app)
  and [remote access to this computer](remote-server.md#remote-access-to-this-computer).
- **AI Model**: [AI models](models.md).
- **Plugins** and **MCP servers**: [plugins](plugins.md) and
  [remote MCP servers](mcp-servers.md).
- **Jobs**: [scheduled jobs](jobs.md).
- **Token usage**: [token usage](token-usage.md).

## Where each setting lives

A setting is saved in one of two places. On the **device**, it applies only to
this app or browser. In the **environment**, it applies to **This computer** or
to the server in use, and every device connected to that server shares it. Each
environment keeps its own, and nothing is copied between them. Each panel says
which it is, and **General** and **Voice input**, which hold both, say it for
each group.

| Panel | Settings | Saved |
| --- | --- | --- |
| **General** | **Name**, **About you** | Environment |
| **General** | **Theme**, **Wisp colors**, **Wisps row**, **Conversation order**, **Reply speed**, **Time format** | Device |
| **General** | **Timezone** | Device, and reported to the environment |
| **General** | **Launch at login** | This computer's system |
| **Connections** | Saved servers and their pairing | Device |
| **Remote access** | **Remote access**, **Address**, **Paired devices** | This computer |
| **AI Model** | **Provider**, **Model**, **Maximum output tokens**, API keys, subscription sign-in, **Fallback**, **Auxiliary models** | Environment |
| **Voice input** | **Microphone**, **Send automatically**, **Provider**, **Model**, **Language**, **Fallback model** | Device |
| **Voice input** | API key | Environment |
| **Plugins** | Connections and their keys, **Default web providers**, which Wisps can use each one | Environment |
| **MCP servers** | Servers, their credentials, which Wisps can use each one | Environment |
| **Permissions** | **Auto-review file changes**, **Create files**, **Modify files**, **Integration blocks** | Environment |
| **Jobs** | Every Wisp's jobs | Environment |
| **Token usage** | Nothing to set; shows the environment's usage | Environment |
| **Storage** | Workspace size limits, and removing files and archives | Environment |
| **Notifications** | Sounds, **Volume**, **System notifications**, **Mute the open conversation**, **Server connection notice** | Device |
| **Shortcuts** | **Voice input** shortcut | Device |
| **About** | Nothing to set; checks for updates | Device |

A few things can be reached from two places on purpose, and both change the
same value:

- A workspace's size limit, in **Storage** and in **Wisp settings → Workspace**.
- Which Wisps can use a plugin or an MCP server, in **Plugins** or **MCP
  servers** and in **Wisp settings → Access**.
- A Wisp's jobs, in **Jobs** and in **Wisp settings → Jobs**.
- A provider's API key, in **AI Model** and in **Voice input**.

**Wisp settings** holds what applies to one Wisp, and some of it overrides a
default here: **Wisp settings → Model** overrides **AI Model**, and **Wisp
settings → Access → Without asking** overrides **Permissions**.

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

- **You** — your **Name**, which your Wisps call you by and send to their AI
  provider when you chat. It also supplies the sidebar name and initials. It is
  required, saved locally in `user-profile.json`, and saved when you leave the
  field or press Enter. Busy Wisps pick up a new name after their current turn.
  Below it, **About you** lists what every Wisp knows about you: add, edit,
  remove, or export it as `USER.md`. See [memory](context-and-memory.md#memory).
- **Application** — theme, Wisp colors, and launch at login. With **Wisp colors** off, replies, the send button, and the selected conversation keep the neutral look instead of each Wisp's color.
- **Date and time** — timezone and time format.

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

## Permissions

**Settings → Permissions** holds what Wisps can do without asking. Auto-review
shows one Allow / Ask / Block choice for **Create files** and one for **Modify
files**; turning auto-review off makes Wisp ask before every file change and
disables the choices. These are the defaults for every Wisp: **Always allow**
and **Always block** on an approval card, and the choices under **Without
asking** in a Wisp's **Access** tab, apply to that Wisp only, as do MCP tools
and plugins always allowed from a card. Integration blocks added from approval
prompts are listed below them (see [security](security.md) for how rules are
applied).

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
rejects its key, or has no credit left. Only models from other providers
with a saved key are listed, since a provider that is down or refusing its key
fails all of its models at once. A fallback whose key is removed later, or
that is from the provider chosen above after a change, is shown as unavailable
and skipped. A recording that is empty, too long, or that a
provider could not read is not sent to the fallback, since it would fail the
same way, and no provider gets the same recording twice.

When transcription fails, the composer keeps the recording: **Try again**
sends it again to the providers as they are set then, so a key saved or a
fallback chosen in the meantime is used without recording anew.

### Recordings that stop early

The screen stays on while recording, where the browser allows it. A recording
that ends before you stop it is kept instead of lost: when the phone is locked
or the system takes the microphone, when the app reloads after losing its
server, or when you open another conversation. The conversation's composer
says so and offers **Transcribe** or **Discard**. Its text waits in the
composer for review, even with **Send automatically** on. A transcription that
had not finished is kept the same way, and offers **Try again**.

A kept recording stays with its conversation until it is transcribed or
discarded, or a new recording starts there. It lives in the app's memory, so
closing the app drops it, and **Esc** discards a recording in progress.

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
see [security](security.md#tool-authorization) for how its disk limits it. The summary
also shows what [recorded runtime events](token-usage.md#runtime-events) take,
when there are any. Sizes are the files' logical lengths, not the space
allocated on disk.

Storage keeps each workspace's last measurement, also across restarts in
`backend/storage-measurements.json`, so opening it measures only what changed:
a workspace is measured again after a turn or a job runs in its conversation,
after files are attached or uploaded, and after a removal from Storage. Each
deleted Wisp's or circle's archive is measured once. **Measured** shows the
oldest measurement on the page. Files changed outside Wisp, for example from
a terminal, show after **Refresh**, which measures every workspace and archive
again.

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
a volume slider (0–100%), and, for each event, a sound and a Test button. In
the desktop app it also has **System notifications**, with a switch and a Test
button per event; see [below](#system-notifications).
Existing sound preferences are preserved. New settings default to full volume,
the **Chime** for all three events, and open-conversation muting off.

Each event's sound is **None**, **Chime**, **Marimba**, **Bell**, **Glass**,
**Pop**, or **Soft**. Choosing one plays it right away; **None** turns that
event's sound off. Every sound is made by the app as it plays, so nothing is
downloaded. In each of them a finished turn rises, an approval falls, and an
error falls lower, so the three stay apart.

- **Response completed** — plays when a Wisp finishes its turn.
- **Approval needed** — plays when a Wisp awaits tool approval.
- **Execution error** — plays when a Wisp's turn fails. Errors outside a turn,
  such as a rejected model change, stay silent.
- **Mute the open conversation** — skips sounds for the selected conversation
  while the app window is visible and focused; background conversations still notify.
- **App notices → Server connection notice** — the "Connected to" notice shown
  when you switch to a server; see [Updates (About)](#updates-about).

All live sounds respect both the global sound toggle and the individual Wisp's
notification toggle. Failed or cancelled turns do not also play the completion
sound. A new sound cuts off one still playing, so sounds never overlap. Volume
zero is silent. Test buttons preview an event's sound at the chosen volume, and
are disabled when its sound is **None**, global sounds are off, or volume is
zero. Settings are saved on this device; disabling sounds retains the volume
and each event's sound. There are no scheduled quiet hours.

System notifications are set apart: an event's **None** does not change its
system notification. With a window open those are silent; with every window
closed they play the system's own sound, which the system's notification
settings control.

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

After an update installs, Wisp reopens and says which version it updated to,
once per version on each device: reopening the window or the app afterwards
says nothing more until the next update.

Opening the app connects to its server without a "Connected to" notice. The
notice appears when you switch to a server, or when connecting took failed
attempts. **Don't show again** in it turns it off on this device, and
**Server connection notice** in **Settings → Notifications → App notices**
turns it back on; the
notices that a server was set up or updated always show.

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
