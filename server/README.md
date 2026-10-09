# @gustmrg/wisp-server

The headless server of [Wisp Bot](https://github.com/gustmrg/wisp-bot), an
open-source desktop app that gives you a squad of AI agents (your Wisps) that
keep working with you across days.

Run the server on a Linux machine you own, such as a home server or a
Raspberry Pi, and your Wisps keep working when no client is connected. The
desktop app connects to it over SSH or a private HTTPS address, and the server
also serves the app to browsers, which you can install on a phone.

## Requirements

- Linux with systemd (for the service; see `--no-service` otherwise)
- Node.js 22.19 or later, with npm
- Your own model provider keys, which you add in the app

## Install

```sh
npx @gustmrg/wisp-server setup
```

For the current account, and without `sudo`, this:

- installs the server in `~/.local/lib/wisp-server`
- creates a master key in `~/.config/wisp/master.key`, which encrypts the
  credentials you save on the server. **Keep a copy somewhere safe.**
- writes the settings to `~/.config/wisp/server.env`
- adds the `wispctl` command to `~/.local/bin`
- starts the `wisp` systemd user service, listening on `127.0.0.1:8787`, and
  turns on linger, when the system allows it, so it keeps running after you
  log out

Run it again whenever you like: it keeps the key and your settings, and
restarts the service only when something changed. To update, run the newest
version:

```sh
npx @gustmrg/wisp-server@latest setup
```

The desktop app can also do this for you: add the machine under
**Settings → Connections** with the SSH option, then choose
**Install the Wisp server**.

### Options

| Option | Effect |
| --- | --- |
| `--port PORT` | The port the server listens on (default `8787`) |
| `--public-origin URL` | The `https://` address of a private proxy such as Tailscale Serve |
| `--data-dir DIR` | Where the server keeps its data (default `~/.local/share/wisp`) |
| `--package SPEC` | Install this npm package, tarball, or folder instead of the matching version |
| `--no-service` | Only install the files, and print the command that starts the server |
| `--no-pair` | Do not print a pairing code |
| `--json` | Print the result as JSON; progress goes to stderr |

Options you pass are saved in `server.env`, so later runs keep them. If
another program already uses the port, the setup stops before it changes
anything; choose a free one with `--port`.

## Connect

- **Desktop app:** in **Settings → Connections**, add the machine with the
  SSH option and the server's port. The app pairs itself over SSH.
- **Browser or phone:** expose the server on your
  [Tailscale](https://tailscale.com) tailnet, then give the server its address:

  ```sh
  tailscale serve --bg http://127.0.0.1:8787
  wispctl setup --public-origin https://<machine>.<tailnet>.ts.net
  ```

  Open that address, and enter a code from `wispctl pair`. Do not use
  Tailscale Funnel: the server must stay private.

## Manage the server

```text
wispctl pair                     Print a one-time pairing code for a new device
wispctl devices                  List paired devices
wispctl revoke --device-id ID    Remove a device and end its sessions
wispctl status                   Show the running server's identity
wispctl backup --output FILE --key-file KEY
                                 Write an encrypted backup of the data directory
wispctl help                     Show every command and option
```

In a terminal, `pair` and `devices` print text to read; piped, or with
`--json`, they print JSON.

The service is a regular systemd user unit:

```sh
systemctl --user status wisp
journalctl --user -u wisp -n 50
```

## Uninstall

```sh
systemctl --user disable --now wisp
rm ~/.config/systemd/user/wisp.service ~/.local/bin/wispctl
systemctl --user daemon-reload
rm -r ~/.local/lib/wisp-server
```

Your Wisps and credentials stay in `~/.local/share/wisp` and `~/.config/wisp`;
delete those too only if you no longer need them.

## More

- [Server guide](https://github.com/gustmrg/wisp-bot/blob/main/docs/remote-server.md):
  settings, Docker, backups, pairing, and the HTTP API
- [Wisp Bot](https://github.com/gustmrg/wisp-bot): the desktop app and its source
- [Issues](https://github.com/gustmrg/wisp-bot/issues)

MIT License
