# Persistent Wisp server

Wisp can run on Linux without Electron. The server owns conversations, model sessions, workspaces, credentials, approvals and execution. Closing a client closes its transport; it does not terminate remote work. One Unix account owns one instance. Paired devices have that owner's authority, including tools that access the server's files.

## Build and run

Use Node **24.18.0 or newer in the Node 24 line** on Linux x64/arm64. The pinned Pi runtime is 0.84.4. SQLite uses `node:sqlite`; no native SQLite npm build or Electron installation is required by the runtime package. Node 24 labels this API experimental.

```sh
npm ci
npm run dist:server
# Copy release/server to ~/.local/lib/wisp on the server, then on that server:
cd ~/.local/lib/wisp
npm ci --omit=dev
mkdir -p ~/.config/wisp ~/.local/share/wisp ~/.local/bin
chmod 700 ~/.config/wisp ~/.local/share/wisp
node server/cli.js keygen --output ~/.config/wisp/master.key
install -m 755 deploy/wispctl ~/.local/bin/wispctl
node server/main.js --data-dir ~/.local/share/wisp \
  --key-file ~/.config/wisp/master.key --owner-name Gustavo \
  --time-zone America/Fortaleza --web-root "$HOME/.local/lib/wisp/web"
```

The server binds `127.0.0.1:8787`. Provider credential storage requires a private, external 32-byte master key. An invalid configured key fails startup; missing secure storage rejects credential persistence with `secure_storage_unavailable`. Retain that key separately from encrypted backups. Never commit keys or put them in browser storage. `--agent-mode fake` is an explicit test-only runtime; normal startup uses Pi and configured provider credentials.

`GET /health/live` and `/health/ready` expose only availability. Conversation and server identity endpoints require pairing. `wispctl status --json` uses the owner-only administrative socket at `$WISP_DATA_DIR/admin.sock`. Set `WISP_DATA_DIR` if using a nondefault location. Logs avoid requests, conversation text, credentials and pairing codes; the CLI intentionally prints short-lived codes when requested.

## Start at boot with systemd

Use the account that will log in through SSH (or a dedicated `wisp` account with its own authorized keys). Install `deploy/systemd/wisp.service` in `~/.config/systemd/user/`. Copy `server.env.example` to `~/.config/wisp/server.env`, replace the example absolute paths and set the instance timezone before its first start. The unit expects Node 24 at `/usr/bin/node`; adjust that absolute path for your installation.

```sh
mkdir -p ~/.config/systemd/user
cp ~/.local/lib/wisp/deploy/systemd/wisp.service ~/.config/systemd/user/
chmod 600 ~/.config/wisp/server.env
systemctl --user daemon-reload
systemctl --user enable --now wisp
journalctl --user -u wisp -f
# An administrator enables boot without an interactive login:
sudo loginctl enable-linger "$USER"
```

`LoadCredential` provides the key through systemd's credentials directory. Restrict SSH access to the owning account: access to `wispctl` is administrative access. Do not make the socket or data directory group/world writable. Tools run as this account; systemd hardening is not a tool sandbox.

## Electron over SSH

In **Connections**, add an SSH profile with the server host, Unix user, SSH port and remote backend port 8787. MagicDNS such as `raspberrypi` works like any other SSH hostname. A custom data directory requires `WISP_DATA_DIR` in the remote account's noninteractive environment.

Install OpenSSH on the client and make `wispctl` available in the remote **noninteractive SSH PATH** (for example install the wrapper in `/usr/local/bin`). Load passphrase-protected keys into the OS SSH agent before connecting. The application never stores SSH passwords or private keys. On first contact, compare the displayed SHA-256 host fingerprint through a trusted channel before trusting it. A changed key requires explicit removal/revalidation. Pairing is performed with the fixed command `wispctl pair --json` over the authenticated channel, then HTTP/SSE goes through a loopback-only tunnel. The profile pins the resulting Wisp server identity.

For Docker, use HTTPS access below or explicitly install an account-owned `wispctl` wrapper that invokes `docker compose exec -T wisp wispctl "$@"`; membership in the Docker group already grants host administrator powers.

## Tailscale

Three different paths are supported:

1. **OpenSSH over the tailnet:** install Tailscale on both ends; enter the IP/MagicDNS name in an ordinary SSH profile. Existing `sshd`, keys and agent apply.
2. **Tailscale SSH:** enable it deliberately on the Linux host with `sudo tailscale set --ssh`, configure tailnet SSH policy, and choose Tailscale SSH in the profile. Interactive check URLs open only after explicit user action. Tailnet network access and SSH policy must both permit the session.
3. **Tailscale Serve HTTPS:** proxy loopback to private HTTPS. This is the browser, PWA and native mobile path and is also usable by Electron HTTPS profiles.

```sh
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Set `WISP_PUBLIC_ORIGIN` to the **exact HTTPS origin** printed by Serve and restart Wisp. Enable only required native origins with `WISP_ALLOWED_ORIGINS=capacitor://localhost,https://localhost`; browser sessions remain same-origin and native sessions use bearer tokens. On the phone, connect the Tailscale app to the same tailnet before opening Wisp. Do not expose port 8787 publicly or enable Funnel. Tailscale headers are not Wisp authentication: every device must still pair.

`deploy/tailscale/policy.hujson` is a policy fragment for adaptation, not a replacement for your tailnet policy. It grants only TCP 22/443 to an example identity and tagged server. Test policy changes in the Tailscale admin console. Official references: [Serve](https://tailscale.com/docs/features/tailscale-serve), [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh), [grants](https://tailscale.com/docs/features/grants), [MagicDNS](https://tailscale.com/docs/features/magicdns).

## Pair web, mobile and HTTPS desktop

Run `wispctl pair --json` as the server owner. Enter the one-time code in the client. Codes expire and are consumed once. Web sessions use HttpOnly, SameSite cookies and CSRF checks; native tokens use Keychain/Android Keystore; Electron uses encrypted main-process storage. Browser caches contain the application shell only. Do not put tokens in URLs or localStorage.

Use `wispctl devices` to list devices and `wispctl revoke --device-id ID` to revoke one, including its active event stream. Losing a device does not require changing all other device sessions. Settings and approvals are shared; stale edits return conflicts and must be reviewed against fresh state.

## Docker

```sh
node dist-server/server/cli.js keygen --output deploy/docker/master.key
# The file must remain 0600 and readable by container uid 1000.
docker compose -f deploy/docker/compose.yaml up --build -d
docker compose -f deploy/docker/compose.yaml exec wisp wispctl pair --json
```

Use a host-owned secret with matching uid or your deployment platform's secret manager. Set `WISP_PUBLIC_ORIGIN`, `WISP_TIMEZONE`, `WISP_OWNER_NAME` and optional native origins before starting. The compose port is published only on host loopback. The runtime runs as uid 1000, drops capabilities, uses a persistent volume and includes only server dependencies. Compose allows 45 seconds for shutdown; use `--stop-timeout 45` for a manual `docker run`. It does not run an SSH server. Bind `0.0.0.0` is explicitly enabled inside the container so the loopback host publishing works.

## Upgrades and limits

Finish/cancel active work, create an encrypted backup, retain the old installation and master key, then stop the service before replacing code. Run `npm ci --omit=dev` on the target architecture and restart. Check readiness and pair a client before discarding the prior package. Restore backups into a **new** data directory for rollback; old device sessions are revoked after restore and must pair again.

One process owns each data directory. Limits preserve four concurrent agents, eight pending requests per conversation and the existing runtime deadline. Request IDs are durable; a disconnected client queries the existing request rather than replaying it. Work interrupted by a server crash is marked interrupted and is never automatically rerun with possible external effects. SSE cursors expire with retention or restore; clients reconcile through a new snapshot. The application does not provide distributed execution or exactly-once effects at external providers.

See [migration and backup](remote-migration.md), [diagnostics](remote-troubleshooting.md), and [mobile build instructions](../mobile/README.md).

## Rotate the credential master key

Create a second private key with `wispctl keygen --output /private/new-master.key`. Stop the service and start it with the new key as `--key-file`/`WISP_MASTER_KEY_FILE` and the old key as `--previous-key-file`/`WISP_PREVIOUS_MASTER_KEY_FILE`. Run `wispctl rotate-key` to atomically re-encrypt the complete credential store using the new active key. Verify credential-dependent operations, then restart without the previous-key option. With systemd, update `LoadCredential` and the corresponding environment paths deliberately. Keep the old key separately until backups encrypted with it have expired; it is never included in an ordinary backup.
