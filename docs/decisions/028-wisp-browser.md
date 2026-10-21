# ADR 028: A browser for Wisps

- Status: Accepted
- Date: 2026-10-21
- Decision owners: Wisp backend and security boundary
- Scope: How a Wisp opens and uses web pages, and where the browser runs
- Related: [ADR 004](004-wisp-plugins.md), [ADR 017](017-container-execution.md),
  [ADR 023](023-wisp-permissions.md), [security](../security.md); Linear SWE-190

## Context

Wisps reach the web through `web_search` and `web_read`, which plugins provide
(ADR 004): a provider's API fetches a page and returns its text. A Wisp cannot
use a page that needs JavaScript, follow links, fill in a form or see what a
page looks like. A Wisp with commands (ADR 017) could install a browser in its
container, but not every Wisp should run commands, and a shell gives the user
no say over what the browser sends.

We looked at how others do it:

- **Hermes Agent** drives the agent-browser CLI (Vercel Labs) as a subprocess,
  or the browser-use harness, against a local Chromium or a hosted browser
  (Browserbase, Browser Use, Firecrawl). URLs on private addresses go to a
  local browser even when a hosted one is configured.
- **OpenClaw** uses `playwright-core` over CDP. In its Docker sandbox the
  browser runs in a container of its own, apart from the shell's, on a
  dedicated network.

## Decision

**A Wisp can have a browser: headless Chromium in a container of its own on
the Wisp's network, driven through Playwright over the container's standard
input. It is a setting of its own and does not need commands.**

- **The setting:** **Use a browser** in the Wisp's **Commands & browser**
  settings, kept with the command settings (`browser` in
  `execution-settings.json`, off by default). It needs Docker or Podman, like
  commands. **Allow local network** applies to both.
- **The tool:** `browser`, offered through the integration tool source in the
  Wisp's own conversation only (not in circles, as for commands). Its actions:
  `open`, `snapshot`, `click`, `type` (optionally pressing Enter), `select`,
  `back`, `wait`, `screenshot` and `close`. Pages are returned as Playwright's
  accessibility snapshot for AI (`page.ariaSnapshot({ mode: "ai" })`), whose
  `[ref=eN]` names the elements the next action uses, cut at 40,000
  characters and marked as untrusted. A screenshot is an image for models that
  take images, and is saved in the workspace for the Wisp to show.
- **The engine:** Playwright (`playwright-core` 1.64.0) and its own headless
  Chromium shell, so the two always match. They are installed in a browser
  image built on the server from a Dockerfile in the code, like the sandbox
  image; nothing is added to the app or the server package.
- **Where it runs:** a container per Wisp's browser, created on the first
  action. The server runs `docker run -i --rm` with a small Node driver as the
  only process and talks to it in JSON lines on standard input and output. The
  container needs no port: a blocked Wisp's network keeps no route out, and
  nothing on the server listens for it. It mounts nothing of the Wisp's, so the
  browser cannot read the workspace, and the Wisp's commands cannot reach the
  browser's cookies.
- **Confinement:** as for commands: the server's user, all capabilities
  dropped, `no-new-privileges`, a read-only root with a 512 MB `/tmp`, 256
  processes, 2 GB of memory (at most a quarter of the machine's) and 2 CPUs.
  Chromium runs without its own sandbox; the container is the boundary.
- **Network:** the Wisp's own network (ADR 017). When the local network is
  blocked, Chromium uses the egress proxy, which refuses private, loopback and
  other non-public addresses after resolving them; the network has no other
  way out, so WebRTC and other traffic that ignores the proxy cannot leave.
  When it is allowed, Chromium goes straight out. The git gateway's token is
  left alone. No domain allowlist.
- **Session:** one browser per Wisp, kept between actions with its page,
  cookies and sign-ins, and closed by `close`, after 10 minutes unused, when
  the setting is turned off or changes, when the Wisp is deleted, and when the
  server stops. Nothing is kept after that: every browser starts with an empty
  profile. The driver closes Chromium when its input ends, so the container
  ends with the server's process even if the server is killed; a container
  left behind is removed before the next one starts and when its Wisp is
  deleted. A driver that does not answer within 90 seconds is killed.
- **Approvals:** two categories. `browser` (opening, reading, following links,
  typing into ordinary fields, choosing options, screenshots) is allowed unless
  a Block rule matches, like commands in a container. `browser_submit` asks
  first: clicking a button, sending a form with a button or with Enter, unless
  it is sent with GET and has no password field (a search), and typing into a
  password field. Before a click or typing, the driver tells the server what
  the element is (its tag, type, role, form method and label), and the card
  names it and the site: "Click the button “Place order” on shop.example.com".
  Risk mode covers `browser_submit`; no rule allows it otherwise, and a Block
  rule stops it. In a job's run nobody can answer, so `browser_submit` runs
  only when the job was approved with the browser, as for any tool.
- **Refused:** downloads, uploads, and addresses other than http and https.
  Dialogs are dismissed and reported to the Wisp.

## Consequences

- A Wisp can read pages that need JavaScript, follow links and fill in forms,
  without commands and without seeing its own workspace from the browser.
- The first action builds the browser image, about 1 GB, once per server.
- **Accepted risk:** the approval looks at the element, not at what the page
  does with it. A page can send what was typed from its own scripts, or make a
  link act like a button; a Wisp misled by a page could type something into a
  field that the page sends without a submit. Credentials and payment details
  belong in a field only when the user gave them for that site, which the
  system prompt says. Every action is in the tool audit log.
- Screenshots are saved in the workspace under `browser-screenshots/`, so the
  Wisp can show them in its reply ([ADR 029](029-files-in-replies.md)).

## Deferred

- **Hosted browsers** (Browserbase, Steel, Kernel, Cloudflare Browser Run) as
  a provider, for servers without Docker or Podman, connected over CDP with
  `playwright-core` in the server. Private addresses would still go to the
  local browser, as Hermes does.
- **Persistent profiles** to keep sign-ins between sessions, and a way for the
  user to sign in themselves (live view) without giving the Wisp the password.
- Downloads into the workspace, with approval.
- Podman: the browser uses the same calls as commands, but has not been tested
  on it (no user runs Podman today).

## Rejected alternatives

- **agent-browser or Playwright inside the Wisp's command container:** needs
  commands on, shares the workspace and the browser's cookies with every
  command, and leaves the user no say over what is sent.
- **CDP from the server to a port published by the container:** a blocked
  Wisp's network is internal, so a published port would need a network with a
  route out, or a forwarder; standard input needs neither.
- **`playwright-core` in the server:** adds the library to the app and the
  server package for no gain while the browser is local; it returns with
  hosted browsers.
- **A domain allowlist:** too limiting for what Wisps are asked to do, as for
  commands; the network boundary does the blocking that matters.
- **Asking before every click:** clicks on links, tabs and menus are how a
  page is read; asking for each would make the browser impractical.
