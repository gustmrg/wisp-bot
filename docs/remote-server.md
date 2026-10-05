# Headless Wisp server

The Wisp server runs the same backend as the desktop app as a long-lived Linux
process, without Electron. Wisps keep working when no client is connected:
closing a client only closes its connection.

This is a preview. The server, pairing, and the HTTP API are complete, but no
client connects to it yet; the desktop app will connect over SSH in a later
release. Until then the server is useful for trying the deployment and for
building clients.

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

A few desktop actions need a screen on the server and return an `unsupported`
error instead: opening a Wisp's folder, attaching local files, and signing in to
an MCP server with OAuth (its callback must reach a browser on the same
machine). Updates and launch at login are desktop-only and are not offered.

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

## Pair devices

Every client pairs once with a one-time code:

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
