# ADR 035: The server's port found over SSH

- Status: Accepted
- Date: 2026-10-29
- Decision owners: Wisp desktop connections
- Scope: Which port an SSH connection's tunnel forwards to, and how the app
  keeps it right
- Related: [Wisp server](../remote-server.md), [ADR 009](009-headless-server.md),
  [ADR 013](013-ssh-questions.md), SWE-246

## Context

An SSH connection forwards a local port to the Wisp server's loopback port,
which the person typed in the connection (8787 by default). When the server
runs on another port, for example because another service already has 8787
and `wispctl setup` was run with `--port 8788`, the tunnel still opens: it
reaches the other service. Pairing then sent the code to that service and
never finished, and nothing said why. A paired device kept retrying.

The app already runs `wispctl pair` over SSH to pair, and `wispctl status
--json` reports the port the server listens on.

## Decision

**The app asks the server for its port over SSH and corrects the connection
by itself.**

- Pairing runs `wispctl status --json && wispctl pair --json` in one SSH
  command. When the status names another port, the connection takes it, and
  the session reopens the tunnel there at once (`ServerMovedError`), pairing
  with the code it already has. It is not counted as a failed attempt.
- `RemoteClient` reports `not_wisp` when something answers without Wisp's
  error envelope or without a `serverId`, including a 401, which no longer
  forgets the device's credentials. For a paired device, the SSH transport
  then runs `wispctl status --json` (`explainFailure`): another port moves
  the connection there; otherwise the app stops with `wrong_port` and says
  that another service answers on that port.
- The port is recorded with `ConnectionStore.setServerPort`, which keeps the
  pairing: the server is the same one, reached over the same SSH login.
  Changing the port by hand in the form still pairs again.
- A setup over SSH records the port its result reports.
- The port field is optional. Without one, a connection starts at 8787, and
  the first connection corrects it.

## Consequences

- A server on another port connects on the first try, and the form no
  longer needs its port.
- Pairing runs one more `wispctl` command in the same SSH session.
- A paired device runs `wispctl status` over SSH only when something other
  than a Wisp server answers, not on every reconnect.
- The stored profile keeps a port, so older builds still read it.

## Deferred

- Leaving the port to the server during a setup: a setup still passes the
  connection's port with `--port`.

## Decisions taken with the user

- When the server's port is found, the app corrects the connection without
  asking.
- The port field is optional.

## Rejected alternatives

- **Asking before changing the port.** The status comes from the server over
  the person's own SSH login, so there is nothing to confirm, and a prompt
  would interrupt the first connection.
- **Running `wispctl status` on every connection.** It costs an SSH round trip
  each time; pairing and failures are the only moments the port can be wrong.
- **Leaving the stored port empty for automatic connections.** Older builds
  require a port and would drop the profile.
