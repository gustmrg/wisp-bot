# ADR 016: Workspace files as MCP tool arguments

- Status: Accepted
- Date: 2026-10-09
- Decision owners: Wisp backend
- Scope: How a workspace file reaches an MCP tool that takes file content
- Related: [ADR 005](005-remote-mcp-servers.md), [MCP servers](../mcp-servers.md),
  [analysis](../mcp-file-arguments-analysis.md)

## Context

A Wisp read two attached bank slips but could not upload them through an MCP
tool that takes the file as base64. MCP arguments are exactly the JSON the
model writes, so the only way for a file to reach a tool was for the model to
write it out token by token. That costs hundreds of thousands of tokens per
file, corrupts easily, exceeds the 200 KB argument limit, and leaves the user
approving an unreadable blob. Wisps have no shell, by design, and a shell would
not help: the bytes would still pass through the model.

## Decision

**The host expands a file reference at dispatch.** The model writes
`wisp-file:<path>` in a file field, and Wisp replaces it with the file's
contents, base64-encoded or as a data URL, just before calling the tool.

- **A string, not an object.** Pi validates arguments against the advertised
  schema; a string reference passes where the field is a string. Constraints
  on the encoded content are dropped from the advertised copy only; the
  reviewed schema and its fingerprint are unchanged.
- **Only in file fields.** A field qualifies when its schema marks it as base64
  or a data URL, by annotation, name, or description. A reference anywhere else
  is refused rather than sent as a literal string. Accepting references in any
  string would let a Wisp send a file to fields never meant for one.
- **Resolved inside the workspace, before asking.** The same resolution as the
  `read` and `write` tools, following symbolic links. At most 5 files and
  10 MB per call, counted before encoding; the 200 KB limit keeps governing
  what the model writes.
- **Always shown.** The approval card names every file and its size. A call
  that sends files is never answered by **Always allow** and does not offer it:
  a tool allowed for queries should not silently start carrying files.
- **Read after approval.** The file is resolved and read again after the
  approval wait and refused if it moved or changed size.

## Consequences

- A workspace file can now leave the machine through MCP, which was not
  practical before. It goes only to tools the Wisp was granted, and only with
  an approval that names it.
- The session history and audit log hold the reference, never the contents.
- Servers that take files some other way (a field the heuristic misses, or an
  upload URL) are not covered. A presigned-URL upload tool can be added later
  without changing this mechanism.
