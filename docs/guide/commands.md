---
title: Running commands
summary: Letting a Wisp run shell commands and git in its own container (Docker or Podman), the container image, a GitHub token for private repositories, and local network access.
---
# Running commands

By default Wisps cannot run commands. In the Wisp's
[Commands](wisp://wisp/execution) settings, set **Run commands** to **In a
container**. It can also be chosen when creating the Wisp.

- Commands run in the Wisp's own container, never directly on your computer.
  It needs Docker or Podman on the computer that runs the Wisps. The container
  sees only the Wisp's workspace.
- **Image** chooses the container image; the default is **Wisp sandbox
  (Debian)**. Changing it recreates the container.
- **GitHub token** — a fine-grained token lets git in the container reach
  your private repositories on github.com. It is stored encrypted, and the
  Wisp can push whatever the token allows.
- Commands reach the internet but not your local network, unless **Allow
  local network** is on.

Commands run without approval cards: the container is the boundary. Do not
keep secrets in a workspace.
