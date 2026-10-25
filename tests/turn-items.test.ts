import { describe, expect, it } from "vitest";

import { ClaudeCodeEventConverter } from "../backend/claude-code/claude-code-events.js";
import { PiEventTranslator, type PiAgentEvent } from "../backend/pi-event-translator.js";
import {
  MAX_TURN_ITEM_DIFF_CHARACTERS,
  MAX_TURN_ITEM_OUTPUT_CHARACTERS,
  describeToolCall,
  maskSecrets,
  type ToolCall,
} from "../backend/turn-items.js";
import type { ConversationAgentEvent, TurnItem } from "../shared/contracts.js";

const WORKSPACE = "/data/wisps/atlas/workspace";

function itemFor(
  toolName: string,
  args: unknown,
  result?: ToolCall["result"],
  status: ToolCall["status"] = "completed",
) {
  return describeToolCall(
    { id: "call-1", toolName, args, status, startedAt: "2026-10-22T10:00:00.000Z", ...(result ? { result } : {}) },
    WORKSPACE,
  );
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("describeToolCall", () => {
  it("shows a command with its purpose, exit code, and the end of its output", () => {
    const output = `${"x".repeat(MAX_TURN_ITEM_OUTPUT_CHARACTERS)}\nlast line`;
    const item = itemFor(
      "run_command",
      { command: "npm test", description: "Run the test suite" },
      { ...text(output), details: { commandResult: { exitCode: 1, durationMs: 20 } } },
    );

    expect(item).toMatchObject({
      type: "command_execution",
      command: "npm test",
      purpose: "Run the test suite",
      exitCode: 1,
      outputTruncated: true,
    });
    expect(item.type === "command_execution" && item.output).toHaveLength(MAX_TURN_ITEM_OUTPUT_CHARACTERS);
    expect(item.type === "command_execution" && item.output?.endsWith("last line")).toBe(true);
  });

  it("reads the exit code Pi appends to a failed command's output when no details came", () => {
    expect(itemFor("run_command", { command: "false" }, text("Command exited with code 2"))).toMatchObject({
      exitCode: 2,
    });
  });

  it("has no output for a command that is still running", () => {
    const item = itemFor("run_command", { command: "sleep 5" }, undefined, "running");
    expect(item).toEqual({
      id: "call-1",
      toolName: "run_command",
      status: "running",
      startedAt: "2026-10-22T10:00:00.000Z",
      type: "command_execution",
      command: "sleep 5",
    });
  });

  it("tells a background process's action, id, and state", () => {
    expect(
      itemFor(
        "process",
        { action: "start", command: "npm run dev" },
        text("Started process 0a1b2c3d.\nNo output yet."),
      ),
    ).toMatchObject({
      type: "background_process",
      action: "start",
      processId: "0a1b2c3d",
      command: "npm run dev",
      state: "running",
    });
    expect(
      itemFor("process", { action: "wait", id: "0a1b2c3d" }, text("Process exited.\nLast output:\nok")),
    ).toMatchObject({ action: "wait", processId: "0a1b2c3d", state: "exited" });
    expect(
      itemFor("process", { action: "wait", id: "0a1b2c3d" }, text("Still running after 30 seconds.\nNo output.")),
    ).toMatchObject({ state: "running" });
    expect(itemFor("process", { action: "kill", id: "0a1b2c3d" }, text("Process 0a1b2c3d stopped."))).toMatchObject({
      action: "kill",
      state: "stopped",
    });
    const listed = itemFor("process", { action: "list" }, text("No background processes."));
    expect(listed).toMatchObject({ action: "list", output: "No background processes." });
    expect(listed).not.toHaveProperty("processId");
    // A start that failed did not leave a process running.
    expect(
      itemFor("process", { action: "start", command: "x" }, text("The process could not be started."), "failed"),
    ).not.toHaveProperty("state");
  });

  it("counts an edit's added and removed lines from its patch and keeps the start of the patch", () => {
    const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", "+more"].join("\n");
    expect(itemFor("edit", { path: `${WORKSPACE}/src/a.ts` }, { ...text("ok"), details: { patch } })).toMatchObject({
      type: "file_change",
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
      diff: patch,
    });
    const long = `+${"y".repeat(MAX_TURN_ITEM_DIFF_CHARACTERS)}`;
    const item = itemFor("edit", { path: "a.ts" }, { ...text("ok"), details: { patch: long } });
    expect(item).toMatchObject({ diffTruncated: true, additions: 1 });
    expect(item.type === "file_change" && item.diff).toHaveLength(MAX_TURN_ITEM_DIFF_CHARACTERS);
  });

  it("counts what a write wrote as added, and nothing for a write that failed", () => {
    expect(itemFor("write", { path: "/workspace/notes.md", content: "a\nb\nc" }, text("ok"))).toEqual(
      expect.objectContaining({ type: "file_change", path: "notes.md", additions: 3 }),
    );
    expect(itemFor("write", { path: "notes.md", content: "a" }, text("denied"), "failed")).not.toHaveProperty(
      "additions",
    );
  });

  it("shows file reads and searches with paths relative to the workspace", () => {
    expect(itemFor("read", { path: `${WORKSPACE}/README.md`, offset: 10 })).toMatchObject({
      type: "file_read",
      paths: ["README.md"],
    });
    expect(itemFor("ls", {})).toMatchObject({ type: "file_read", paths: ["."] });
    expect(itemFor("ls", { path: WORKSPACE })).toMatchObject({ paths: ["."] });
    expect(itemFor("grep", { pattern: "TODO", path: "src" })).toMatchObject({
      type: "file_search",
      pattern: "TODO",
      path: "src",
    });
    expect(itemFor("find", { pattern: "*.ts" })).toEqual(
      expect.objectContaining({ type: "file_search", pattern: "*.ts" }),
    );
  });

  it("shows web searches, pages read, and where the browser went, never what was typed", () => {
    expect(itemFor("web_search", { query: "pi agent" })).toMatchObject({ type: "web_search", query: "pi agent" });
    expect(itemFor("web_read", { url: "https://example.com/a" })).toMatchObject({
      type: "web_read",
      url: "https://example.com/a",
    });
    expect(
      itemFor(
        "browser",
        { action: "open", url: "https://example.com" },
        text("URL: https://example.com/\nTitle: Example"),
      ),
    ).toMatchObject({ type: "browser", action: "open", url: "https://example.com/", pageTitle: "Example" });
    const typed = itemFor(
      "browser",
      { action: "type", ref: "e3", text: "hunter2-password", submit: true },
      text("URL: https://example.com/login\nTitle: (none)"),
    );
    expect(typed).toEqual(expect.objectContaining({ action: "type", url: "https://example.com/login" }));
    expect(typed).not.toHaveProperty("pageTitle");
    expect(JSON.stringify(typed)).not.toContain("hunter2");
  });

  it("shows any other tool by its name alone", () => {
    expect(itemFor("save_skill", { name: "weekly", content: "secret plan" }, text("Saved"))).toEqual({
      id: "call-1",
      toolName: "save_skill",
      status: "completed",
      startedAt: "2026-10-22T10:00:00.000Z",
      type: "tool",
    });
  });

  it("masks secrets in commands, output, and diffs, and strips terminal escapes", () => {
    const secrets = [
      "sk-ant-api03-abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "xoxb-1234567890-abcdefghij",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    const command = [
      `curl -H "Authorization: Bearer abcdef123456789" https://user:hunter2@example.com`,
      `export API_KEY=plain-value-1 GITHUB_TOKEN='quoted value'`,
      `psql --password=dbpass123`,
      ...secrets.map((secret) => `echo ${secret}`),
    ].join(" && ");
    const output = `\u001b[31mred\u001b[0m\nDB_PASSWORD: s3cret!\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----`;
    const patch = `+const client = new Client({ apiKey: "live-key-123" });\n+SECRET_TOKEN=abc123`;
    const items: TurnItem[] = [
      itemFor("run_command", { command, description: "Use token=abc" }, text(output)),
      itemFor("process", { action: "start", command }, text(output)),
      itemFor("edit", { path: "a.ts" }, { ...text("ok"), details: { patch } }),
    ];
    const serialized = JSON.stringify(items);

    for (const secret of [
      ...secrets,
      "abcdef123456789",
      "hunter2",
      "plain-value-1",
      "quoted value",
      "dbpass123",
      "s3cret!",
      "MIIEow",
      "live-key-123",
      "abc123",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("\\u001b");
    expect(items[0]).toMatchObject({ output: expect.stringMatching(/^red\n/) });
    expect(serialized).toContain("https://[hidden]@example.com");
  });

  it("leaves ordinary text alone", () => {
    const value = "npm run build && git status --short\nDone in 3.2s, 12 files";
    expect(maskSecrets(value)).toBe(value);
  });
});

describe("turn items through the translator", () => {
  function translate(events: PiAgentEvent[]): ConversationAgentEvent[] {
    const published: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => published.push(event), 0, WORKSPACE);
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Go" });
    for (const event of events) translator.handle(event);
    return published;
  }

  const items = (events: ConversationAgentEvent[]) =>
    events.flatMap((event) =>
      event.type === "turn_item" ? [{ groupId: event.groupId, ...event.item, startedAt: "", completedAt: "" }] : [],
    );

  it("groups the steps between two parts of the reply", () => {
    const tool = (id: string): PiAgentEvent[] => [
      { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } },
      { type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false, result: text("x") },
    ];
    const published = translate([
      { type: "agent_start" },
      ...tool("a"),
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it." } },
      ...tool("b"),
      ...tool("c"),
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } },
      { type: "agent_settled" },
    ]);

    expect(
      published.flatMap((event) =>
        event.type === "turn_item" && event.item.status === "completed"
          ? [`${event.item.id}@${event.groupId}`]
          : event.type === "assistant_message_completed"
            ? [event.messageId]
            : [],
      ),
    ).toEqual(["a@r1:work", "r1:assistant", "b@r1:work:2", "c@r1:work:2", "r1:assistant:2"]);
  });

  it("ends the steps a stopped turn left running as cancelled", () => {
    const published: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => published.push(event), 0, WORKSPACE);
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Go" });
    translator.handle({ type: "agent_start" });
    translator.handle({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "run_command",
      args: { command: "x" },
    });
    translator.markCancelled();
    translator.handle({ type: "agent_settled" });

    const last = published.filter((event) => event.type === "turn_item").at(-1);
    expect(last).toMatchObject({ item: { id: "a", status: "cancelled", completedAt: expect.any(String) } });
    expect(published.at(-1)).toMatchObject({ type: "conversation_status", status: "idle" });
  });

  it("shows the same steps for a call on Claude Code as on Pi", () => {
    const patch = "--- a/a.ts\n+++ b/a.ts\n-old\n+new";
    const result = { content: [{ type: "text", text: "Edited a.ts" }], details: { patch } };
    const pi = translate([
      { type: "agent_start" },
      { type: "tool_execution_start", toolCallId: "toolu_1", toolName: "edit", args: { path: "a.ts", edits: [] } },
      { type: "tool_execution_end", toolCallId: "toolu_1", toolName: "edit", isError: false, result },
      { type: "agent_settled" },
    ]);
    const converter = new ClaudeCodeEventConverter();
    const claude: PiAgentEvent[] = [{ type: "agent_start" }];
    claude.push(
      ...converter.convert({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "mcp__wisp__edit", input: { path: "a.ts", edits: [] } }],
        },
      }).events,
    );
    converter.recordToolResult("toolu_1", result);
    claude.push(
      ...converter.convert({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Edited a.ts" }] },
      }).events,
      { type: "agent_settled" },
    );

    expect(items(translate(claude))).toEqual(items(pi));
    expect(items(pi).at(-1)).toMatchObject({ type: "file_change", path: "a.ts", additions: 1, deletions: 1 });
  });
});
