# ADR 017: Running commands in per-Wisp containers

- Status: Accepted
- Date: 2026-10-10
- Decision owners: Wisp backend and security boundary
- Scope: How a Wisp runs shell commands, and where
- Related: [ADR 001](001-agent-runtime.md), [ADR 009](009-headless-server.md),
  [ADR 016](016-mcp-file-arguments.md), [security](../security.md)

## Context

Wisps had no shell (`excludeTools: ["bash", "powershell"]` since the first Pi
session). That kept them inside their workspace: every file path is confined
and file changes are reviewed. It also meant a Wisp asked to work on code could
not clone a repository, create a branch, install dependencies or run tests.

Pi's shell runs on the server as the server's user, so enabling it would reach
every file that user can read: other Wisps, the encrypted stores and, on a
headless server, the master key file next to them. Web pages, issues and MCP
results are model input, so a page could talk a Wisp into running a command.
Per-command approval does not fix this: a script cannot be reviewed in a card,
and approving each `npm test` makes development impractical.

## Decision

**Commands run in a container per Wisp, and only for Wisps given that mode.**

- **Modes per Wisp:** `off` (the default, as before) or `container`. Pi's own
  `bash` and `powershell` stay excluded: commands never run on the server
  itself. A later mode may run them over SSH on a machine the user chooses.
- **The tool:** `run_command`, Pi's bash tool with its execution replaced. It
  is offered through the integration tool source, so turning commands on or
  changing the image rebuilds the session, and the system prompt says where
  commands run.
- **The container:** one per Wisp, created on its first command, stopped after
  30 minutes without one, removed when the Wisp is deleted or its settings
  change. Docker or Podman, found on the server; with neither, the mode is
  unavailable and says why.
- **What it sees:** only the Wisp's workspace, mounted at `/workspace`, the
  same files its file tools see. The home folder is `/workspace/.home`, so what
  the Wisp installs is kept and counts toward the workspace size. Nothing else
  from the server is mounted: no other Wisp, no config or credential store, no
  container socket. None of the server's environment variables are passed.
- **Confinement:** the server's own user ID (with `--userns=keep-id` under
  rootless Podman, so workspace files stay the server's), no sudo, all
  capabilities dropped, `no-new-privileges`, a read-only root with a 1 GB
  `/tmp`, at most 512 processes, 4 GB of memory and 2 CPUs (less on smaller
  machines).
- **The image:** built on the server from a Dockerfile in the code
  (`debian:trixie-slim` with git, curl, Node.js, Python, build tools, ripgrep
  and jq), tagged by its contents, so nothing is downloaded from a registry we
  run. A Wisp can use another image instead; it is pulled on first use.
- **No approval per command.** The container is the boundary, so commands run
  as in a terminal. `container_command` is allowed by policy unless a Block
  rule matches, and every command is in the tool audit log (category only,
  never the command). A short list of commands that would wipe the workspace
  or fork-bomb is refused outright; it guards against mistakes, not attacks.
- **Network:** open. Data, packages and repositories are on the internet.
- **Git:** a GitHub token per Wisp, stored encrypted like other keys. It
  reaches a command through the container program's environment, never its
  arguments, and git's credential helper hands it to github.com. Pushing is
  not approved separately: the token's scope is the authorization, so the user
  limits it to the repositories and permissions the Wisp needs.
- **Size:** checked between commands. A command is refused while the workspace
  holds more than its size; a running command cannot be stopped from writing
  past it.
- **Cancellation:** each command runs in its own process group; Stop, the
  request deadline or a timeout kills the group. Whatever a command leaves in
  the background is killed when it ends.

## Consequences

- A Wisp can do development work: clone, branch, edit, build, test, push.
- **Accepted risk:** a Wisp misled by content it read can send its workspace
  contents anywhere, or push what its token allows. Secrets do not belong in a
  workspace, and tokens should be narrow.
- The container can reach the local network, including services on the
  server's other interfaces. The Wisp server listens on loopback by default,
  which the container cannot reach; blocking private ranges needs an egress
  proxy and is left for later.
- Whoever runs the Wisp server needs Docker or Podman. Membership in the
  `docker` group is root-equivalent on that machine; rootless Podman avoids it.
  Only the server talks to the container program; Wisps never see its socket.
- Background processes (dev servers, watchers) do not survive a command yet.
  A process tool, an egress proxy and an SSH mode are follow-ups.

## Rejected alternatives

- **Enabling Pi's shell on the server**, with or without a denylist: no
  boundary at all; denylists are bypassed by any script.
- **Per-command approval:** unreviewable for scripts and impractical for
  development loops.
- **bubblewrap or similar:** Linux only, while Docker and Podman also run on
  macOS.
- **No network, or an allowlist of domains:** too limiting for what Wisps are
  asked to do.
- **A token approval on every push:** a credential helper cannot tell a push
  from a fetch reliably, and the user chose to rely on the token's scope.
