# Security and authorization

## Renderer trust boundary

Sandboxing and context isolation stay enabled. Navigation and permission
requests default to deny; the Content Security Policy is generated for the
renderer; the sandboxed preload exposes a frozen, typed `WispApi` bridge, and
every IPC handler validates its payload and checks that the sender is the main
frame at the trusted renderer URL. See
[the Electron security checklist](electron-security-checklist.md) for the
reviewed invariants.

## Credential storage

API keys and sign-in tokens are stored under the user-data directory, separate
per store (model keys and subscription sign-ins, voice input keys kept apart
from a subscription sign-in, plugin keys, MCP secrets),
encrypted with AES-256-GCM under the local
server's key. That key is random and is itself encrypted with Electron's
operating-system-backed `safeStorage` API:

- macOS: Keychain-backed encryption;
- Windows: DPAPI-backed encryption for the current OS user;
- Linux: the desktop secret store selected by Electron.

Saved keys are never returned to the renderer. Wisp refuses to persist keys
when secure storage is unavailable (including Electron's `basic_text` fallback
on Linux); plaintext files, renderer storage, environment values, command-line
arguments, telemetry, and logs are prohibited credential locations. Unreadable
credentials disable the affected integration tools without preventing core
Wisp conversations.

## Remote servers

The backend always runs as a Wisp server. On this computer, the app starts it
as a child process and keeps its credential key encrypted with `safeStorage`;
the key reaches the server only on its stdin. Only that app's device is
"local": the server asks it, and no other device, to open folders, file
pickers, or sign-in pages. When the app uses a server on another machine, that
server holds every provider key, encrypted with its own master key file, and
runs every tool on its own files. The desktop keeps only the device's pairing credentials, encrypted with
`safeStorage` like other keys; they stay in the main process and never reach
the renderer. SSH tunnels use the system OpenSSH client, so OpenSSH verifies
host keys against `known_hosts` and Wisp never sees SSH keys. When OpenSSH
asks to trust a new host key, for a password, or for a key passphrase, it
asks through an askpass helper that reaches the main process over a private
socket with a per-process token; answers go back to OpenSSH and are never
stored or logged. A password is only used to add this computer's public key
to the server ([ADR 013](decisions/013-ssh-questions.md)). Profile fields are
validated so they cannot become OpenSSH options. Direct connections require HTTPS, except to this computer. Revoking a
device on the server ends its sessions, and the app does not pair again
without a user's request. The browser app served by a server keeps its
session in `HttpOnly`, `SameSite=Strict` cookies, never in page storage, and
the server accepts cookie-authenticated changes only from its own origin with
an `X-Wisp-Request` header. See [headless server](remote-server.md).

## Tool authorization

Read-only workspace tools are always available; file creation and modification
pass through main-process policy and user approval. Unknown file actions are
blocked, and conflicting auto-review rules resolve with `block` → `ask` →
`allow` precedence. File mutations are limited to 1 MB of input and tool
output to 64 KB.

Each Wisp's workspace is a private folder under the backend data directory,
capped at 512 MiB unless the Wisp is given another size. **Wisp settings →
General → Workspace** offers 64, 128, 256 and 512 MiB, 1, 2, 10, 50 and
100 GiB, and **Unlimited**; growing needs that much room on the server's disk,
and shrinking below what the workspace holds deletes nothing but stops new
files. An unlimited workspace is still measured, and is held back only by its
disk: attachments, uploads, file changes and commands are refused once they
would leave less than 1 GiB free there, so the conversations, sessions and
settings on the same disk can still be saved. Choosing it asks for
confirmation first. The size is kept in the Wisp's config directory, outside
the workspace, so the Wisp cannot change it; an unlimited workspace keeps its
last size there too, which older servers apply. A file change that would
exceed the cap is refused before the approval prompt. The same
panel shows usage and opens the workspace folder; the path is computed by the
main process. Attached
files are picked in a native dialog owned by the main process and copied into the
workspace `inbox/` folder (at most 20 per request, never overwriting); the
renderer never supplies a file path. On a server on another computer, and in
the browser app, the device uploads the picked files instead: the server takes
only the base name, sanitizes it, writes to a hidden partial file, and links it
into `inbox/` without overwriting once exactly the declared size arrived.

An approval request waits 30 minutes and is then denied; the card shows the
remaining time. While a card waits, the request's 10-minute deadline is paused.
For a workspace file change the card also offers **Always allow creating
files** or **Always allow editing files**, and **Always block**. They apply to
that Wisp and that category only, are kept in the Wisp's config directory, and
can be changed in the Wisp's **Access** tab; a category the Wisp sets nothing
for follows Settings → General → Auto-review. Blocking an integration call
stores an app-wide integration-scope rule. See
[ADR 023](decisions/023-wisp-permissions.md).

**Allow everything** (risk mode) in a Wisp's **Access** tab lets that Wisp
create and edit files, write to plugins, call MCP tools and send forms in its
browser, including calls that send workspace files, without asking. It never covers skills, jobs or
commands outside a container, app-wide Block rules still win, and so does the
Wisp's own Block for a kind of file change. Each action it allows is logged as
`allow_everything` in the tool audit log.

Integration access is granted per Wisp (see [plugins](plugins.md) and
[remote MCP servers](mcp-servers.md)) and rechecked in the backend on every
call. Linear writes require `write` access plus an approval through the
authorization broker, unless the person always allowed that tool, or all of
Linear, for that Wisp from a card or chose **Write without asking**; workspace
auto-review rules cannot allow integration writes. MCP calls run under a
generic `integration_call` category that asks and can only be blocked, never
allowed, by policy rules. The user can always allow one MCP tool for one Wisp
from its approval card; that permission is bound to the reviewed tool
definition, so a changed tool asks again. **Use without asking** allows every
tool of a server for one Wisp, including changed ones, except calls that send
workspace files. A Block rule still wins over all of them. Approval cards show a
bounded operation description with secret-like values redacted, and access is
rechecked after the approval wait and again immediately before dispatch.

Cancellation cannot roll back a mutation already accepted remotely; uncertain
write outcomes instruct the agent to check the external system before retrying.

With an image model chosen in **Settings → AI Model → Auxiliary models**, the
`read` tool sends images and scanned PDF pages from the workspaces of Wisps on
text-only models to that model's provider, which can differ from the provider
running the conversation (see [AI models](models.md#auxiliary-models)). The
returned text is marked as data from the user's file, not instructions; the
image model receives no tools. The cache of transcriptions lives in each
Wisp's config directory, outside the workspace, is deleted with the Wisp, and
is not backed up.

Skills (see [ADR 008](decisions/008-wisp-skills.md)) live in each Wisp's
config directory, outside the workspace, so file tools cannot read or change
them. `save_skill` always asks and shows the exact instructions; rules and
auto-review cannot allow it, and its card offers no lasting decision. Skill
instructions are treated as user-provided context and never grant tools.

Every Wisp can create, change and delete the person's other Wisps
([ADR 024](decisions/024-chief-and-wisp-tools.md)). `create_wisp`,
`update_wisp` and `delete_wisp` always ask, like `save_skill`: the card shows
the name, role and soul, or for a deletion repeats the warning of the
settings' delete button. Rules, auto-review and **Allow everything** cannot
allow them, their cards offer no lasting decision, a Wisp cannot change or
delete itself, and job runs never get these tools.

## Commands

A Wisp runs commands only when **Wisp settings → General → Commands & browser** is set
to run them in a container ([ADR 017](decisions/017-container-execution.md)).
Its `run_command` and `process` tools run commands, in the foreground or in
the background, in that Wisp's own Docker or Podman container, which mounts only the Wisp's workspace and receives none of the
server's environment variables, config or credential stores. The container
runs as the server's user without sudo, with all capabilities dropped,
`no-new-privileges`, a read-only root, and process, memory and CPU limits. It
can reach the internet, but not the local network unless **Allow local
network** is on: its container sits on an internal network of its own whose
only way out is an egress proxy that refuses private, loopback, link-local and
other non-public addresses after resolving them itself. Commands run without approval cards: the container is
the boundary, a Block rule for `container_command` stops them all, and the
audit log records each one without its text. Commands that would wipe the
workspace are refused. The GitHub and GitLab tokens never enter the
container: git reaches github.com and the GitLab plugin's instance through a
gateway in the egress proxy that carries only git's own protocol and adds the
token there, so a Wisp can clone and push what the token allows but cannot read
it or call the GitHub or GitLab API with it. A GitLab instance on the local
network is reached through the gateway even when the Wisp's local network is
blocked, for git only. A misled Wisp can send its
workspace contents over the network, so secrets do not belong in a workspace.

## Browser

A Wisp has a browser only when **Use a browser** is on in its **Commands &
browser** settings ([ADR 028](decisions/028-wisp-browser.md)); it does not
need commands. Its `browser` tool drives headless Chromium in a container of
its own, confined like the command container, that mounts nothing of the
Wisp's: the browser cannot read the workspace. The server talks to it over the
container's standard input, so it publishes no port. It sits on the Wisp's own
network and, unless **Allow local network** is on, reaches the internet only
through the egress proxy. Opening and reading pages, following links and
typing into ordinary fields run without asking (`browser`); clicking a button,
sending a form other than a search, and typing a password ask first
(`browser_submit`), and a Block rule stops either. Downloads and uploads are
refused. The browser keeps cookies and sign-ins only until it is closed or
unused for 10 minutes.

## Prohibited patterns

Pi's automatic discovery of project extensions, skills, prompts, and context
files remains disabled; Pi's shell and PowerShell tools stay excluded, so no
command ever runs on the server itself.
External search and issue content is model input, not authorization or
executable instructions.
