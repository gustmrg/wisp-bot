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

API keys are encrypted with Electron's operating-system-backed `safeStorage`
API and stored under the user-data directory, separate per store (model keys,
plugin keys, MCP secrets):

- macOS: Keychain-backed encryption;
- Windows: DPAPI-backed encryption for the current OS user;
- Linux: the desktop secret store selected by Electron.

Saved keys are never returned to the renderer. Wisp refuses to persist keys
when secure storage is unavailable (including Electron's `basic_text` fallback
on Linux); plaintext files, renderer storage, environment values, command-line
arguments, telemetry, and logs are prohibited credential locations. Unreadable
credentials disable the affected integration tools without preventing core
Wisp conversations.

## Tool authorization

Read-only workspace tools are always available; file creation and modification
pass through main-process policy and user approval. Unknown file actions are
blocked, and conflicting auto-review rules resolve with `block` → `ask` →
`allow` precedence. File mutations are limited to 1 MB of input and tool
output to 64 KB.

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

## Prohibited patterns

Pi's automatic discovery of project extensions, skills, prompts, and context
files remains disabled; bundled tools do not enable shell or PowerShell access.
External search and issue content is model input, not authorization or
executable instructions.
