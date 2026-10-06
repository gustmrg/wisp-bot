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
the renderer. SSH tunnels use the system OpenSSH client with BatchMode, so
OpenSSH verifies host keys against `known_hosts` and Wisp never sees SSH keys
or passwords; profile fields are validated so they cannot become OpenSSH
options. Direct connections require HTTPS, except to this computer. Revoking a
device on the server ends its sessions, and the app does not pair again
without a user's request. See [headless server](remote-server.md).

## Tool authorization

Read-only workspace tools are always available; file creation and modification
pass through main-process policy and user approval. Unknown file actions are
blocked, and conflicting auto-review rules resolve with `block` → `ask` →
`allow` precedence. File mutations are limited to 1 MB of input and tool
output to 64 KB.

Each Wisp's workspace is a private folder under the backend data directory,
capped at 512 MB. A file change that would exceed the cap is refused before
the approval prompt. **Wisp settings → General → Workspace** shows usage and
opens the workspace folder; the path is computed by the main process. Attached
files are picked in a native dialog owned by the main process and copied into the
workspace `inbox/` folder (at most 20 per request, never overwriting); the
renderer never supplies a file path.

An approval request expires after 60 seconds and is then denied; the card
shows the remaining time. For a workspace file change, while auto-review is on,
the card also offers **Always allow creating files** or **Always allow editing
files**. It saves an Allow rule for that category only, visible and reversible
in Settings → General → Auto-review. The broker refuses this decision for
integration calls and while auto-review is off. **Always block** saves a Block
rule the same way; blocking an MCP call stores an integration-scope rule.

Integration access is granted per Wisp (see [plugins](plugins.md) and
[remote MCP servers](mcp-servers.md)) and rechecked in the backend on every
call. Linear writes require `write` access plus an expiring, single-use
**Allow once** approval through the authorization broker; workspace auto-review
rules cannot allow integration writes. MCP calls run under a generic
`integration_call` category that always asks and can only be blocked, never
auto-allowed. Approval cards show a bounded operation description with
secret-like values redacted, and access is rechecked after the approval wait
and again immediately before dispatch.

Cancellation cannot roll back a mutation already accepted remotely; uncertain
write outcomes instruct the agent to check the external system before retrying.

Skills (see [ADR 008](decisions/008-wisp-skills.md)) live in each Wisp's
config directory, outside the workspace, so file tools cannot read or change
them. `save_skill` always asks and shows the exact instructions; rules and
auto-review cannot allow it, and its card offers no lasting decision. Skill
instructions are treated as user-provided context and never grant tools.

## Prohibited patterns

Pi's automatic discovery of project extensions, skills, prompts, and context
files remains disabled; bundled tools do not enable shell or PowerShell access.
External search and issue content is model input, not authorization or
executable instructions.
