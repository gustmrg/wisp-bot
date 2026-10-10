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

API keys are stored under the user-data directory, separate per store (model
keys, plugin keys, MCP secrets), encrypted with AES-256-GCM under the local
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
capped at 512 MB unless the Wisp is given another size. **Wisp settings →
General → Workspace** offers 512 MB, 2, 10, 50 and 100 GB; growing needs that
much room on the server's disk, and shrinking below what the workspace holds
deletes nothing but stops new files. The size is kept in the Wisp's config
directory, outside the workspace, so the Wisp cannot change it. A file change
that would exceed the cap is refused before the approval prompt. The same
panel shows usage and opens the workspace folder; the path is computed by the
main process. Attached
files are picked in a native dialog owned by the main process and copied into the
workspace `inbox/` folder (at most 20 per request, never overwriting); the
renderer never supplies a file path. On a server on another computer, and in
the browser app, the device uploads the picked files instead: the server takes
only the base name, sanitizes it, writes to a hidden partial file, and links it
into `inbox/` without overwriting once exactly the declared size arrived.

An approval request expires after 60 seconds and is then denied; the card
shows the remaining time. For a workspace file change, while auto-review is on,
the card also offers **Always allow creating files** or **Always allow editing
files**. It saves an Allow rule for that category only, visible and reversible
in Settings → General → Auto-review. The broker refuses this decision while
auto-review is off and for integration calls, except an MCP tool card's
**Always allow this tool** (see below). **Always block** saves a Block rule the
same way; blocking an MCP call stores an integration-scope rule.

Integration access is granted per Wisp (see [plugins](plugins.md) and
[remote MCP servers](mcp-servers.md)) and rechecked in the backend on every
call. Linear writes require `write` access plus an expiring, single-use
**Allow once** approval through the authorization broker; workspace auto-review
rules cannot allow integration writes. MCP calls run under a generic
`integration_call` category that asks and can only be blocked, never allowed,
by policy rules. The user can always allow one MCP tool for one Wisp from its
approval card; that permission is bound to the reviewed tool definition, so a
changed tool asks again, and a Block rule still wins. Approval cards show a
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

## Commands

A Wisp runs commands only when **Wisp settings → General → Commands** is set
to run them in a container ([ADR 017](decisions/017-container-execution.md)).
Its `run_command` tool runs each command in that Wisp's own Docker or Podman
container, which mounts only the Wisp's workspace and receives none of the
server's environment variables, config or credential stores. The container
runs as the server's user without sudo, with all capabilities dropped,
`no-new-privileges`, a read-only root, and process, memory and CPU limits. It
can reach the internet. Commands run without approval cards: the container is
the boundary, a Block rule for `container_command` stops them all, and the
audit log records each one without its text. Commands that would wipe the
workspace are refused. A Wisp's GitHub token is stored encrypted and reaches
git through the container program's environment, never a command line; it
lets the Wisp push whatever the token allows. A misled Wisp can send its
workspace contents over the network, so secrets do not belong in a workspace.

## Prohibited patterns

Pi's automatic discovery of project extensions, skills, prompts, and context
files remains disabled; Pi's shell and PowerShell tools stay excluded, so no
command ever runs on the server itself.
External search and issue content is model input, not authorization or
executable instructions.
