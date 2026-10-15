---
title: MCP servers
summary: Connecting remote MCP servers (HTTPS, with no authentication, a header or OAuth), testing and refreshing their tools, giving Wisps access, and always allowing a tool.
---
# MCP servers

[MCP servers](wisp://settings/mcp) connects outside tools that speak the
Model Context Protocol.

## Add a server

Add the server's HTTPS address and choose its authentication: **None**, an
**Authentication header** (stored encrypted), or **OAuth** (sign in in the
browser). Wisp discovers the server's tools when it is saved;
**Test connection** checks it and **Refresh tools** discovers them again.
Only remote servers over HTTPS are supported, not local (stdio) servers.
OAuth sign-in needs the desktop app on the computer that runs the Wisps.

## Give a Wisp access

Adding a server grants nothing. Grant it in each Wisp's
[Access](wisp://wisp/access) page, or for every Wisp at once in the server's
**Wisp access** section. Every MCP tool call asks for approval; the approval
card's **Always allow this tool** skips the question for that tool and Wisp
until the tool changes. The Wisp's Access page lists always-allowed tools so
you can make them ask again.

Some models accept a limited number of tools. If a reply fails because of too
many tools, remove access to servers the Wisp does not need.
