# Headless Wisp server

The Wisp server is the backend: conversations, agents, credentials, and
tools. The desktop app is always its client. On **This computer**, the app
starts the server as a child process and talks to it exactly as it talks to a
server on another machine.

Run the server by itself on a Linux machine and Wisps keep working when no
client is connected: closing a client only closes its connection. The desktop
app connects to such a server over SSH or a private HTTPS address; see
[Connect the desktop app](#connect-the-desktop-app). Web and mobile clients
come later.

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
folder, attaching files, and signing in to an MCP server with OAuth (its
callback must reach a browser on the same machine). The server asks the
desktop app that started it to do these, through `hostRequest` events; for any
other device they return an `unsupported` error. Updates and launch at login
are desktop-only and are not offered.

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

Requires Node.js 22.19 or later on Linux.

Build the package from a checkout:

```sh
npm ci
npm run package:server     # writes release/server
```

Copy it to `~/.local/lib/wisp` on the server, for example with
`scp -r release/server myserver:.local/lib/wisp` (create `~/.local/lib` first).
Then, on the server:

```sh
mkdir -p ~/.config/wisp ~/.local/bin
cd ~/.local/lib/wisp && npm install --omit=dev
chmod 700 ~/.config/wisp
node ~/.local/lib/wisp/server/cli.js keygen --output ~/.config/wisp/master.key
install -m 755 ~/.local/lib/wisp/deploy/wispctl ~/.local/bin/wispctl
```

The master key encrypts provider, plugin, MCP, and voice credentials. Keep a
copy outside the server: without it, saved credentials cannot be read and must
be entered again. The server refuses a key file that other accounts can read.
Without a key the server still starts, but every credential save fails with
`secure_storage_unavailable`.

## Run

```sh
WISP_MASTER_KEY_FILE=~/.config/wisp/master.key node ~/.local/lib/wisp/server/main.js
```

| Option | Variable | Default |
| --- | --- | --- |
| `--data-dir` | `WISP_DATA_DIR` | `~/.local/share/wisp` |
| `--key-file` | `WISP_MASTER_KEY_FILE` | none |
| `--port` | `WISP_PORT` | `8787` |
| `--host` | `WISP_HOST` | `127.0.0.1` |
| `--allow-external-bind` | `WISP_ALLOW_EXTERNAL_BIND=1` | off |
| `--public-origin` | `WISP_PUBLIC_ORIGIN` | none |

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

### systemd

`deploy/systemd/wisp.service` is a user unit:

```sh
cp ~/.local/lib/wisp/deploy/systemd/server.env.example ~/.config/wisp/server.env
chmod 600 ~/.config/wisp/server.env      # then replace the example paths
mkdir -p ~/.config/systemd/user
cp ~/.local/lib/wisp/deploy/systemd/wisp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wisp
journalctl --user -u wisp -f
# Keep it running without an open login session:
sudo loginctl enable-linger "$USER"
```

The unit expects Node at `/usr/bin/node`; adjust `ExecStart` otherwise.

### Docker

From the repository root:

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

Some actions need a screen on the server's computer and are not available on a
server on another machine: opening a Wisp's folder, attaching files from this
computer, and signing in to an MCP server with OAuth.

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
- `POST /api/v1/auth/logout` revokes the calling device.
- `GET /health` reports liveness without authentication.

Authenticated requests carry `Authorization: Bearer <accessToken>`. An event
stream is authorized when it opens and stays open until the device is revoked
or disconnects; an expired access token only affects new requests. The server
answers no browser origins in this release.

Repeating `sendMessage` with a request ID the server already accepted is
rejected rather than run again, so a client can retry safely when a response is
lost.

See [ADR 009](decisions/009-headless-server.md) for the design.
