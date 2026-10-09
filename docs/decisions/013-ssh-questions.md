# ADR 013: SSH questions in the app

- Status: Accepted
- Date: 2026-10-09
- Decision owners: Wisp desktop connections
- Scope: How the desktop app authenticates to a Wisp server over SSH
- Related: [Wisp server](../remote-server.md), [security](../security.md), [ADR 009](009-headless-server.md)

## Context

The desktop app reaches servers with the system OpenSSH client, and ran it in
`BatchMode`, so OpenSSH could never ask anything. That had two costs:

- A host had to be trusted with `ssh` in a terminal first, or the app refused it.
- A server that worked in a terminal with a password failed in the app with
  "rejected this computer's SSH key". The terminal asked for the password,
  while the app could only use keys, and the key in ssh-agent was not in the
  server's `authorized_keys`. Nothing in the message pointed at either.

## Decision

The app lets OpenSSH ask the person, through `SSH_ASKPASS` with
`SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4 or later), instead of `BatchMode`:

- **Unknown host key.** OpenSSH's own question, with the fingerprint, is shown
  in the app. Trusting it lets OpenSSH write `known_hosts`; Wisp never writes
  it and never uses `accept-new`. A changed host key is still refused by
  OpenSSH, and the app explains how to clear it with `ssh-keygen -R`.
- **Password.** Used only to add one public key of this computer to the
  server's `~/.ssh/authorized_keys`, like `ssh-copy-id`: the first key file
  OpenSSH would use for that host (from `ssh -G`, so `~/.ssh/config` counts),
  or else the first key in ssh-agent. Never every key in the agent, which may
  hold keys meant for other machines, such as CI deploy keys. The dialog shows
  the key's comment and fingerprint. The password answers the tunnel and that
  one command, and is then forgotten. From then on Wisp connects with the key, so
  reconnects never ask again. Without a key on this computer, the app does not
  ask for the password and says how to create one.
- **Key passphrase**, key confirmations, and other server questions (such as
  one-time codes) are shown as OpenSSH asks them. Passphrases are not kept;
  `ssh-add` stops the questions.

The askpass helper is a script in a private temporary directory (mode 0700)
that runs Electron as Node.js and reaches the main process over a Unix socket
in that directory, with a random token for each ssh process. Questions reach
the renderer in `ConnectionsView.sshPrompt`, one at a time, and are answered
over IPC. A question unanswered for two minutes, sshd's default login grace
time, is declined, as are questions from a connection that stopped. Declining
ends the attempt without automatic retries.

When OpenSSH still turns the app away, the message names the user OpenSSH
tried (which `~/.ssh/config` may set), says whether the server also accepts a
password, and gives the `ssh-copy-id` command and a `BatchMode` test command
for that user and port.

## Consequences

- Passwords and passphrases now pass through the renderer and the main
  process. They are never stored, logged, or kept in a connection profile.
- Connecting to a new server needs no terminal.
- Windows keeps `BatchMode` until the helper has a Windows form; the app is
  not built for Windows yet.

## Alternatives considered

- **Keep the password** (in memory or the system keychain) to answer every
  reconnect: rejected. A connection opens several ssh processes and
  reconnects with backoff, so a kept password would be used often and long,
  while a key does the same without it.
- **`ControlMaster`** to reuse one authenticated connection: rejected, as it
  is not available on Windows and does not survive a dropped connection.
- **Fetching host keys with `ssh-keyscan`** and writing `known_hosts` from the
  app: rejected. It duplicates checks OpenSSH already does, including refusing
  changed keys.
- **Generating a key for Wisp**: not now. Most people who use SSH already
  have one, and the app says how to create one otherwise.
