# MCP file arguments analysis

Date: 2026-10-09. Status: implemented; see [ADR 016](decisions/016-mcp-file-arguments.md) for the decision as built.

## Problem

A Wisp could read two attached bank slips (PDF) and extract their amount, due
date, and CNPJ, but could not attach them through the BitFinance MCP server. The
server's upload tool takes the file as base64 or a `data:` URL, and the Wisp
replied that it had no way to encode a binary file.

The missing piece is not a shell or an encoder. Wisp has no path for a
workspace file's bytes to reach an MCP tool; today the only way is for the model
to write them out as tool-call arguments.

## How it works today

| Step | Implementation | Consequence |
| --- | --- | --- |
| Attachments | `messageWithAttachments` in `shared/workspace.ts` copies files into the workspace and adds their paths to the message | The model knows where the file is, not what bytes it holds |
| PDF reading | `withDocumentReading` and `backend/pdf-reader.ts` | Returns text and page images for understanding; the original bytes never reach the model |
| MCP dispatch | `executeTool` in `backend/mcp-service.ts` calls `connection.callTool(tool.name, args)` | Arguments are exactly the JSON the model produced; the host never transforms them |
| Argument limit | `MAX_ARGUMENT_JSON_BYTES = 200_000` in `backend/mcp-service.ts` | Larger payloads are refused |
| Shell | `excludeTools: ["bash", "powershell"]` in `backend/pi-conversation-agent.ts` | Intentional; Wisps cannot run scripts |

## Why a shell or an encoding tool would not fix it

Even if the Wisp could produce base64, it would have to read that text into its
context and then write it back as output inside the tool-call arguments:

- **Cost:** a 150 KB slip becomes about 200 KB of base64, hundreds of thousands
  of input and output tokens. It is slow, expensive, and one wrong character
  corrupts the file.
- **Limit:** the payload exceeds `MAX_ARGUMENT_JSON_BYTES`, so the call is
  refused anyway.
- **Approval:** the approval card would summarize an unreadable blob.

Pasting base64 into the chat, as the Wisp suggested, has the same problems. The
original skill worked in a scripting environment because the script made the
HTTP call and the model never handled the bytes.

## Recommendation

Let the host expand a file reference at dispatch time. The model passes a
pointer; Wisp replaces it with the file's contents just before the call.

1. **Reference syntax the model can write cheaply**, for example
   `wisp-file:inbox/bill.pdf` in place of a string value. A string rather than
   an object, because Pi validates arguments against the schema and the field
   is a string.
2. **Resolution in `executeTool`**, between `validateToolArguments` and
   `callTool`:
   - confine the path to the Wisp's workspace with the same rules as the
     `read` and `write` tools;
   - read the file, detect its media type, and substitute the form the schema
     expects (`data:<type>;base64,...` or plain base64);
   - apply a separate size limit after expansion. `MAX_ARGUMENT_JSON_BYTES`
     keeps governing what the model writes, not the file.
3. **Approval shows the file, not the blob**: for example
   "BitFinance › upload_attachment — file: bill.pdf (148 KB, PDF)". The summary
   stays host-generated, so the user approves knowing which file leaves the
   machine and where it goes.
4. **Tell the model where references are accepted.** Annotate tool parameters
   whose schema signals binary content (`contentEncoding: "base64"`,
   `format: "data-url"`, or a name or description that mentions base64 or a
   data URL) in the description produced by `toolInputSchema`. Generic names
   such as `file` or `content` alone are not enough. Accepting references in
   every string would widen the exfiltration surface more than needed.
5. **Tests with a fake MCP server**: the server receives the correct base64;
   paths outside the workspace, missing files, and oversized files are refused;
   the approval summary names the file; a reference in a parameter that takes
   no file is refused.

### Security

Today a workspace file cannot practically leave through MCP, because the model
would have to transcribe it. Expansion makes that possible, so:

- it applies only to tools the user already granted to that Wisp;
- every expanded file is named in the approval card, and a call that carries
  files always asks, even for a tool marked "Always allow";
- the tool audit log records the file path and size, never its contents.

This changes what can leave the workspace, so it is recorded in
[ADR 016](decisions/016-mcp-file-arguments.md).

## Alternatives considered

- **Presigned upload URL** (the MCP server returns a URL and Wisp performs the
  upload): better for large files, but depends on each server offering it and
  needs a new generic HTTP upload tool.
- **MCP resources or another protocol channel:** the specification has no
  standard client-to-server upload, so it does not solve the general case.
- **Enabling the shell:** contradicts an explicit security decision and still
  routes the bytes through the model's tokens.
