# Electron security checklist

Verified for the Phase 6 backend boundary:

- Renderer runs with `contextIsolation`, Chromium sandboxing, and no Node integration.
- Preload exposes a fixed, typed IPC allowlist through `contextBridge`.
- Every IPC handler validates the sender frame and runtime payload.
- Production navigation is restricted to the built renderer; new windows are denied.
- `shell.openExternal` only receives `https:`, `http:`, or `mailto:` URLs without embedded credentials. Rendered links open through the denied new-window path; MCP OAuth authorization URLs must be HTTPS.
- The renderer applies a restrictive content security policy.
- Provider credentials remain encrypted in the main process and never enter renderer events.
- Plugin keys use a separate encrypted store; configuration responses never return saved secrets.
- Automatic discovery of project Pi extensions, skills, prompts, and context files is disabled. Controlled bundled Brave Search and Linear tools are registered explicitly; arbitrary plugins, endpoints, and MCP servers are not accepted.
- Plugin access defaults to deny for every Wisp and is bound to its immutable application session ID. Calls recheck live grants; revocation cancels pending approvals and requests.
- Linear mutations require an expiring, single-use integration approval. Workspace auto-review rules cannot authorize external writes.
- Bundled plugin requests use fixed HTTPS provider endpoints, reject redirects, and enforce request/response bounds. Remote mutation cancellation is not a rollback guarantee.
- Shell and PowerShell tools are excluded and cannot be enabled by tool policy.
- File paths are canonicalized against the Wisp workspace, including symlink parents.
- Mutation paths are revalidated after approval and before execution.
- Approval responses are expiring, single-use, and bound to a window, conversation, and tool call.
- Tool arguments, file contents, provider errors, and tool output are not sent in renderer events.
- Prompt, queue, concurrency, response-event, mutation-input, and tool-output limits are enforced.
- Structured logs redact sensitive keys and secret-shaped values and omit prompts/tool content.
- Agent sessions, pending approvals, subscriptions, and IPC handlers are disposed on shutdown.

Packaging validation in this repository currently covers the Linux Electron runtime. Windows and macOS packaging remain release-environment checks because no cross-platform packager or signing configuration is checked in yet.
