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
  itself. An SSH mode is deferred; see below.
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
- **Network:** the internet is open; data, packages and repositories are
  there. The local network is blocked unless the Wisp is allowed it. A blocked
  Wisp's container sits on its own `--internal` network with no route out; its
  only way out is a shared egress proxy container (Node, run from the sandbox
  image) that is also on that network as `wisp-egress`. The proxy resolves each
  destination itself, refuses it if any answer is a private, loopback,
  link-local, CGNAT, multicast or reserved address (IPv4 and IPv6), and
  connects to the address it checked. Wisp containers get `HTTP_PROXY` and
  `HTTPS_PROXY`, which curl, git, npm and pip honour; anything else (git over
  SSH, raw TCP) cannot leave. Each Wisp has its own network, so Wisps cannot
  reach each other's containers.
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
- **Background processes:** a second tool, `process`, starts long-running
  commands (dev servers, watchers, long builds) in their own session and lets
  the Wisp list them, read their output, wait for them and stop them. At most
  8 run at once; their output is kept in the container's `/tmp`. They count
  as activity, but stop with the container after 30 minutes without a command
  or process call. They are reachable from other commands in the container,
  not from the user's browser.

## Consequences

- A Wisp can do development work: clone, branch, edit, build, test, push.
- **Accepted risk:** a Wisp misled by content it read can send its workspace
  contents anywhere, or push what its token allows. Secrets do not belong in a
  workspace, and tokens should be narrow.
- A Wisp allowed the local network can reach devices and services on the
  server's network, including the server's other interfaces. Blocked Wisps
  cannot, but tools that ignore the proxy variables, such as Node.js 20's
  built-in `fetch`, cannot reach the internet either.
- Whoever runs the Wisp server needs Docker or Podman. Membership in the
  `docker` group is root-equivalent on that machine; rootless Podman avoids it.
  Only the server talks to the container program; Wisps never see its socket.

## Deferred: SSH mode

A third mode would run a Wisp's commands over SSH on a machine the user
chooses, such as a development VM, instead of in a container. It is deferred
(2026-10-10): containers cover development work, and SSH needs more than a
command runner. Recorded here so it is not rebuilt from scratch:

- **The machine is the boundary.** Nothing confines commands on it, so the
  settings must say so; it suits a dedicated VM, not the user's own computer.
- **Files must move too.** `read`, `write`, `edit`, `grep`, `find` and `ls`
  work on the server's workspace, so either they run on the remote machine
  (Pi's tools accept pluggable operations; to be confirmed for each) or the
  workspace lives there and attachments are uploaded to it. Mixing a local
  workspace with remote commands is rejected: the Wisp would see two different
  sets of files.
- **Reuse the SSH connections Wisp already has** (system OpenSSH,
  `known_hosts`, askpass, [ADR 013](013-ssh-questions.md)); no new key store.
- **Approval:** commands outward of the machine are not contained, so
  `git push` and similar may need the auxiliary-model risk check
  ([ADR 012](012-auxiliary-models.md)) plus a hard blocklist, as Hermes Agent
  does for its non-container backends.
- **Size, cancellation and background processes** need the same guarantees as
  in containers: a size check between commands, killing a command's process
  group, and the `process` tool working remotely.

Tracked in Linear as SWE-135.

## Decisions taken with the user

- The container runs as a regular user, never root.
- The default image is based on `debian:trixie-slim`.
- Pushing relies on the GitHub token's scope; there is no approval per push.
- Containers stop after 30 minutes without a command.
- The internet stays open; only the local network is blocked, and a Wisp can
  be allowed it.
- Each Wisp's workspace size is set per Wisp (512 MB to 100 GB) and also
  bounds what its container installs.

## Rejected alternatives

- **Enabling Pi's shell on the server**, with or without a denylist: no
  boundary at all; denylists are bypassed by any script.
- **Per-command approval:** unreviewable for scripts and impractical for
  development loops.
- **bubblewrap or similar:** Linux only, while Docker and Podman also run on
  macOS.
- **No network, or an allowlist of domains:** too limiting for what Wisps are
  asked to do.
- **Blocking private ranges with firewall rules:** needs root on the server and
  differs between Docker, Podman and macOS; an internal network plus a proxy
  works the same everywhere.
- **A token approval on every push:** a credential helper cannot tell a push
  from a fetch reliably, and the user chose to rely on the token's scope.
