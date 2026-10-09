# Headless Wisp server

The Wisp server is the backend: conversations, agents, credentials, and
tools. The desktop app is always its client. On **This computer**, the app
starts the server as a child process and talks to it exactly as it talks to a
server on another machine.

Run the server by itself on a Linux machine (`npx @gustmrg/wisp-server setup`)
and Wisps keep working when no client is connected: closing a client only
closes its connection. The desktop
app connects to such a server over SSH or a private HTTPS address; see
[Connect the desktop app](#connect-the-desktop-app). The server also serves
the app to browsers, which you can install on a phone; see
[Use Wisp in a browser or on your phone](#use-wisp-in-a-browser-or-on-your-phone).

## What runs where

The server owns everything the desktop backend owns: conversations, Pi
sessions, model and plugin credentials, MCP connections, skills, workspaces,
tool policy, and approvals. Its data directory has the desktop's layout under
`backend/`, plus server state:

```text
~/.local/share/wisp/          # WISP_DATA_DIR, mode 0700
├── backend/                  # Same stores as the desktop's userData/backend
├── server.sqlite             # Server identity, paired devices, pairing codes
├── instance.lock             # Held while a server owns the directory
└── admin.sock                # Owner-only administrative socket
```

A few actions need a screen on the server's computer: opening a Wisp's
folder, picking files to attach, and signing in to an MCP server with OAuth
(its callback must reach a browser on the same machine). The server asks the
desktop app that started it to do these, through `hostRequest` events; for any
other device, opening folders and signing in return an `unsupported` error.
Other devices attach files by picking them on their own screen and uploading
them. Updates and launch at login are desktop-only and are not offered.

## On this computer

The desktop app starts `server/main.js` with its own Electron runtime as Node
(`ELECTRON_RUN_AS_NODE`), using the app's data directory, so conversations
created by earlier versions stay where they are. The first stdin line carries
the credential key and a one-time pairing code; stdin stays open, and the
server shuts down when it closes, so it never outlives the app, even after a
crash. The key is random and kept encrypted by the system keychain
(`local-server-key.json`); on first start the app re-encrypts credentials that
earlier versions encrypted with the keychain directly, keeping each original as
`*.keychain-backup`. The local server starts only while **This computer** is
the chosen connection and stops, after its Wisps settle, when you switch away
or quit. Disabling Electron's `RunAsNode` fuse would break this mode.

## Install

You need a Linux machine with systemd, Node.js 22.19 or later (with npm), and
internet access. Run this on it, as the account that should own the Wisps:

```sh
npx @gustmrg/wisp-server setup
```

It installs the server, starts it, and prints what to do next, including a
pairing code. In detail, it:

1. installs `@gustmrg/wisp-server` in `~/.local/lib/wisp-server`;
2. creates the master key `~/.config/wisp/master.key` (mode 0600) and
   `~/.config/wisp/server.env`, which holds the settings below;
3. writes `~/.local/bin/wispctl`, the administrative command;
4. installs and starts the systemd user unit `wisp`, and enables lingering so
   Wisps keep working after you log out (if that needs administrator rights,
   it tells you the `sudo loginctl enable-linger` command to run);
5. waits until the server answers, then prints a pairing code.

The master key encrypts provider, plugin, MCP, and voice credentials. Keep a
copy outside the server: without it, saved credentials cannot be read and must
be entered again. The server refuses a key file that other accounts can read.
Without a key the server still starts, but every credential save fails with
`secure_storage_unavailable`.

Run it again whenever you like: it keeps the key and your settings, skips
what is already installed, and restarts the service only when something
changed. To update, run the newest version, which installs itself:

```sh
npx @gustmrg/wisp-server@latest setup
```

| Option | Effect |
| --- | --- |
| `--port PORT` | The port the server listens on (default `8787`) |
| `--public-origin URL` | The `https://` address of a private proxy; see [browser or phone](#use-wisp-in-a-browser-or-on-your-phone) |
| `--data-dir DIR` | Where the server keeps its data (default `~/.local/share/wisp`) |
| `--package SPEC` | Install this npm package, tarball, or folder instead of the matching version |
| `--no-service` | Only install the files, and print the command that starts the server |
| `--no-pair` | Do not print a pairing code |
| `--json` | Print the result as JSON; progress goes to stderr |
| `--until-stdin-closes` | Stop, before starting the service, when stdin closes; the desktop app cancels this way |

Options you pass are saved in `server.env`, so later runs keep them.

### From the desktop app

If the machine accepts SSH connections from your computer, the app can run the
setup for you. Add the server under **Settings → Connections** with the SSH
option, then choose **Install the Wisp server** (it also appears when a
connection fails). The app asks first, then runs `npx @gustmrg/wisp-server@<its
own version> setup` on the machine over SSH, and connects. The same button
(**Install or update the server**) in the server's settings updates it to the
app's version. The app shows the server's version next to the connection and
warns when it differs from its own; when the two no longer speak the same
protocol, it refuses to connect and says which one to update. This needs Node.js and npm in the PATH of
non-interactive SSH commands, and a version of the app that is published on npm.
**Cancel setup**, or choosing another connection, stops it, also on the machine;
what was already installed stays, and a service not yet started is left alone.

### Settings

`setup` writes `~/.config/wisp/server.env`, which the service reads. Edit it,
then `systemctl --user restart wisp`; command-line options of `server/main.js`
use the same names:

| Option | Variable | Default |
| --- | --- | --- |
| `--data-dir` | `WISP_DATA_DIR` | `~/.local/share/wisp` |
| `--key-file` | `WISP_MASTER_KEY_FILE` | `~/.config/wisp/master.key` |
| `--port` | `WISP_PORT` | `8787` |
| `--host` | `WISP_HOST` | `127.0.0.1` |
| `--allow-external-bind` | `WISP_ALLOW_EXTERNAL_BIND=1` | off |
| `--public-origin` | `WISP_PUBLIC_ORIGIN` | none |
| `--web-root` | `WISP_WEB_ROOT` | the package's `web/` folder |

The server listens on loopback only. Reach it through an SSH tunnel or a
private HTTPS proxy such as Tailscale Serve; never publish the port. Binding
another address requires `--allow-external-bind`, meant for containers that
publish the port on host loopback. Requests must address a loopback name
(`127.0.0.1`, `localhost`, or `[::1]`, on any port, since tunnels forward from
another port) or the public origin's host name when one is set; anything else
is refused, which blocks DNS rebinding.

One server owns a data directory at a time. A second one exits with "Another
Wisp server is already using this data directory." On `SIGTERM` the server
stops accepting requests and gives running Wisps ten seconds to settle.

Day to day, the service is an ordinary systemd user unit:

```sh
systemctl --user status wisp
journalctl --user -u wisp -f
systemctl --user restart wisp
```

To remove the server, run `systemctl --user disable --now wisp`, then delete
`~/.config/systemd/user/wisp.service`, `~/.local/lib/wisp-server`, and
`~/.local/bin/wispctl`. Your Wisps live in `~/.local/share/wisp`, and the key in
`~/.config/wisp`; delete them only when you want everything gone.

Without systemd, or to supervise the server yourself, run `setup --no-service`
and use the command it prints.

### Docker

Docker needs no Node.js on the host. From a checkout of the repository:

```sh
head -c 32 /dev/urandom > deploy/docker/master.key
chmod 600 deploy/docker/master.key
sudo chown 1000:1000 deploy/docker/master.key   # the container's user
docker compose -f deploy/docker/compose.yaml up --build -d
docker compose -f deploy/docker/compose.yaml exec wisp wispctl pair
```

The compose file publishes the port on host loopback only and keeps data in the
`wisp-data` volume.

## Connect the desktop app

A new installation first asks **Where should your Wisps run?**: **On this
computer** (recommended) or **On a Wisp server**. Nothing runs until one is
chosen. Installations that already have Wisps on this computer keep using it.
Each place keeps its own Wisps, conversations, settings, and credentials;
nothing is copied between them.

To add or switch servers later, open **Settings → Connections** and add the
server:

- **SSH** uses this computer's OpenSSH client with your agent, keys,
  `~/.ssh/config`, and known hosts. Enter a host name, IP address, or alias,
  an optional user and SSH port, and the server's port (8787 by default). Wisp
  forwards a free local port to the server's loopback port; it never stores SSH
  keys or passwords. Connect once with `ssh` in a terminal first, so the host
  key is verified; Wisp refuses unknown or changed host keys rather than
  accepting them. MagicDNS names and Tailscale SSH work like any other host; if
  Tailscale SSH asks for a browser check, run `ssh` in a terminal once.
  Use **Test connection** in the connection form to check the current host, user,
  and SSH port before saving. It reports authentication and network failures
  without showing raw SSH output, and times out after 20 seconds. You can edit
  the fields and test again. Success verifies SSH authentication only; it does
  not check the Wisp server port, pair, or switch your active connection.
- **HTTPS address** connects directly, for example to a Tailscale Serve
  address. Plain HTTP is accepted only for `127.0.0.1` and `localhost`.

Choosing **Use** switches every Wisp, conversation, setting, credential, and
approval to that server; the app reloads from it. Over SSH, pairing runs
`wispctl pair` on the server for you; this needs `wispctl` in `~/.local/bin`
or on the PATH of non-interactive SSH sessions. Otherwise, or for an HTTPS
address, enter a code from `wispctl pair` when asked.

The app reopens the last connection on its next start, and starts its local
server only while **This computer** is chosen. If the server cannot be
reached, a banner says so and the app reconnects with backoff; Wisps on the
server keep working meanwhile. A device that was revoked asks to pair again
and never pairs again on its own. Pairing credentials are kept with the
system keychain; without one, the app pairs again after every restart.

Attaching files works on any server: the app opens this computer's file picker
and uploads the files into the Wisp's workspace `inbox/` folder, with the same
512 MB workspace cap and 20 files per message. Opening a Wisp's folder and
signing in to an MCP server with OAuth need a screen on the server's computer
and are not available on a server on another machine.

**Settings → Connections** has a short **How to set up a Wisp server** guide
that summarizes this page. When pairing over SSH fails, the app says what is
missing on the server: `wispctl`, Node.js, the server files, or a running
server, and offers to install it (see [From the desktop app](#from-the-desktop-app)).

## Back up and restore

A backup covers one environment: a server's data directory, or the desktop
app's own (the Wisps that run on **This computer**). Environments stay
isolated; there is no tool to copy conversations from one to another.

A backup holds the conversations, Wisps, Pi sessions, workspaces, skills,
settings, tool policy, paired devices, and credentials (still encrypted with
the environment's key). Logs, caches, locks, and sockets are left out, and so
are links and special files. The archive is encrypted with AES-256-GCM under
its own 32-byte key, so keep that key apart from the backups:

```sh
wispctl keygen --output ~/.config/wisp/backup.key
wispctl backup --output /backups/wisp-2026-10-05.wispbak --key-file ~/.config/wisp/backup.key
wispctl verify --input /backups/wisp-2026-10-05.wispbak --key-file ~/.config/wisp/backup.key
```

A running server writes the backup itself, so give paths the server's account
can write (inside a container, container paths). It refuses while a Wisp is
working, and pauses API calls while it copies; databases are copied through
SQLite's backup API. With no server running, `wispctl` backs up the directory
directly, holding its lock so no server starts meanwhile.

Restore always goes into a new, empty directory. Nothing is written there
unless the whole archive is authentic and complete:

```sh
wispctl restore --input /backups/wisp-2026-10-05.wispbak \
  --key-file ~/.config/wisp/backup.key --target ~/.local/share/wisp-restored
```

Start the server on the restored directory with the **same master key** it
had, or the saved provider keys cannot be read and must be entered again.
The server keeps its identity and paired devices; clients reconnect and
reload. The directory may live at a different path than the original.

### The desktop app's data

Quit the app first: its server has no admin socket, and `wispctl` refuses a
directory in use. The app bundles `wispctl`; run it with the app's own runtime,
for example on Linux with the `.deb` package:

```sh
ELECTRON_RUN_AS_NODE=1 "/opt/Wisp Bot/wisp-bot" \
  "/opt/Wisp Bot/resources/app.asar/dist-electron/server/cli.js" \
  backup --data-dir ~/.config/wisp-bot --output ~/wisp-desktop.wispbak --key-file ~/backup.key
```

To restore, restore into a new directory, then, with the app closed, move the
current `~/.config/wisp-bot` aside and put the restored one in its place. The
app's credential key is sealed by the system keychain: on the same computer and
account, saved API keys keep working; elsewhere the app starts with a new key
and asks for them again. Connection profiles and window preferences are not part
of the environment and start fresh.

## Pair devices

Every client pairs once with a one-time code. The desktop app does this over
SSH by itself; other clients use:

```sh
wispctl pair        # prints a code such as KD7QX-M2PZR, valid for 10 minutes
wispctl devices     # lists paired devices
wispctl revoke --device-id ID
wispctl status
```

`wispctl` talks to the running server through `admin.sock`, so it works only
for the account that owns the data directory; set `WISP_DATA_DIR` or
`--data-dir` for a non-default location. Every paired device acts for that one
owner, including tools that touch the server's files. Revoking a device ends
its sessions and closes its event stream. After ten failed pairing attempts in
a minute, pairing pauses for a minute.

## Use Wisp in a browser or on your phone

The server serves the same app as the desktop, on every path outside the API.
Open its address in a browser, pair once with a code from `wispctl pair`, and
use the Wisps on the server. Browsers need HTTPS for the microphone and for
installing the app, so reach the server through a private HTTPS proxy such as
Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
```

Set `WISP_PUBLIC_ORIGIN` to that exact origin (for example
`https://pi.tail1234.ts.net`) and restart the server: it accepts that host
name, marks session cookies `Secure`, and lets pages from that origin call it.
Do not use Funnel; the server must stay on your tailnet.

On a phone:

1. Install the Tailscale app and sign in to the same tailnet.
2. Open the server's address in Safari (iPhone) or Chrome (Android).
3. Run `wispctl pair` on the server and enter the code.
4. Install it: **Share → Add to Home Screen** in Safari, or **Install app** in
   Chrome. It then opens full screen, like an app, with no account or app
   store.

The browser app is the same Wisp with a few differences:

- It always uses the server that served it. **Settings → Connections** shows
  that server and **Sign out of this browser**, which revokes the device.
- Attaching files uses the browser's file picker and uploads the files to the
  server.
- Opening a Wisp's folder, signing in to an MCP server with OAuth, updates,
  and launch at login belong to the desktop app and are hidden or report that
  they are unavailable.
- Voice input works over HTTPS. iPhones record `audio/mp4`, which the voice
  providers accept.
- A service worker caches only the app's files, never conversations or API
  responses, so the app opens without a network and reconnects when it can.
  A new server version is picked up on the next launch.

## HTTP API

The API mirrors the desktop bridge, so a client implements it mechanically:

- `POST /api/v1/auth/pair` with `{ code, deviceName }` returns device
  credentials: a 15-minute access token and a 30-day refresh token.
- `POST /api/v1/auth/refresh` with `{ refreshToken }` returns new credentials.
  Refresh tokens rotate on every use; the previous one keeps working for one
  minute so a client can retry when the response was lost.
- `GET /api/v1/server` returns the server's identity and the operations it
  offers. Clients should pin `serverId` after pairing.
- `POST /api/v1/rpc/<operation>` runs a `WispApi` operation (for example
  `createConversation`) with the same request the desktop sends over IPC, and
  answers its `BackendResult`. Byte arrays travel as `{ "$bytes": "<base64>" }`.
- `GET /api/v1/events` streams server-sent events: `agentEvent`,
  `conversationChanged`, and `mcpSettingsChanged`. Each event has an id;
  reconnecting with `Last-Event-ID` replays what was missed. When that is not
  possible (the server restarted, or the gap is too long) the stream starts
  with a `resync` event, and the client reloads state before continuing.
- `POST /api/v1/workspace-files?conversationId=<id>&name=<file name>` stores
  one file in a Wisp's workspace `inbox/` folder. The body is the file's raw
  bytes and must declare its `Content-Length`; the answer is a
  `BackendResult` with the attachment's name, workspace path, and size. A file
  that would exceed the workspace cap is refused before it is read, and one
  that arrives shorter or longer than declared is discarded. Requests have no
  overall time limit so large files can finish over slow links; a connection
  that sends nothing for two minutes is closed.
- `POST /api/v1/auth/logout` revokes the calling device.
- `GET /health` reports liveness without authentication.

Authenticated requests carry `Authorization: Bearer <accessToken>`, or, for
the browser app, the session cookies described below. An event stream is
authorized when it opens and stays open until the device is revoked or
disconnects; an expired access token only affects new requests.

Browsers pair with `{ "mode": "web" }`. The server then keeps both tokens in
`HttpOnly`, `SameSite=Strict` cookies (`Secure` behind HTTPS) and answers only
the device and server IDs, so no script on the page can read a token. Every
cookie-authenticated change, including pairing and refreshing, must come from
the server's own origin and carry `X-Wisp-Request: 1`, which a cross-site form
cannot send. Other browser origins are refused.

Repeating `sendMessage` with a request ID the server already accepted is
rejected rather than run again, so a client can retry safely when a response is
lost.

See [ADR 009](decisions/009-headless-server.md) for the design.
