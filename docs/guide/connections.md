---
title: Connections and Wisp servers
summary: Running Wisps on this computer or on a Wisp server, connecting over SSH or HTTPS, installing or updating the server from the app, and what is kept separately in each place.
---
# Connections and Wisp servers

[Connections](wisp://settings/connections) chooses where your Wisps run.

- **This computer** — the default. Wisps run while the app is open.
- **A Wisp server** — a Linux machine running the Wisp server, so Wisps keep
  working (jobs, scheduled messages) with the app closed. Add it over **SSH**
  (with your SSH keys and config) or by its **HTTPS address**, such as a
  Tailscale Serve address. Over SSH, **Install the Wisp server** sets it up
  for you, and **Install or update the server** updates it to the app's
  version. The panel has a short **How to set up a Wisp server** guide.

Choosing **Use** switches every Wisp, conversation, setting and key to that
place. Each place keeps its own; nothing is copied between them.

On a server, opening a Wisp's folder and MCP OAuth sign-in are not available
from other computers. Files you attach are uploaded to it.
