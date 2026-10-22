import { describe, expect, it } from "vitest";

import { commandResultOf, toolStepDetail, toolStepResult } from "../backend/tool-step-detail.js";

const WORKSPACE = "/data/wisps/atlas/workspace";

describe("toolStepDetail", () => {
  it("names workspace paths relative to the workspace and drops paths outside it", () => {
    expect(toolStepDetail("read", { path: `${WORKSPACE}/src/app.ts` }, WORKSPACE)).toEqual({ target: "src/app.ts" });
    expect(toolStepDetail("edit", { path: "./notes.md", oldText: "secret body" }, WORKSPACE)).toEqual({
      target: "notes.md",
    });
    expect(toolStepDetail("ls", { path: WORKSPACE }, WORKSPACE)).toEqual({ target: "." });
    expect(toolStepDetail("read", { path: "/etc/passwd" }, WORKSPACE)).toBeUndefined();
    expect(toolStepDetail("read", { path: "../other/file" }, WORKSPACE)).toBeUndefined();
    expect(toolStepDetail("read", { path: "~/.ssh/id_ed25519" }, WORKSPACE)).toBeUndefined();
  });

  it("shows searches and pages, without a page's query string", () => {
    expect(toolStepDetail("web_search", { query: "pi agent\nevents" }, WORKSPACE)).toEqual({
      target: "pi agent events",
    });
    expect(toolStepDetail("grep", { pattern: "TODO", path: "src" }, WORKSPACE)).toEqual({ target: "src" });
    expect(toolStepDetail("web_read", { url: "https://example.com/docs/a?token=abc#x" }, WORKSPACE)).toEqual({
      target: "example.com/docs/a",
    });
    expect(toolStepDetail("web_read", { url: "file:///etc/hosts" }, WORKSPACE)).toBeUndefined();
  });

  it("drops secret-looking values and never shows a file's content", () => {
    expect(toolStepDetail("web_search", { query: "api key=sk-123" }, WORKSPACE)).toBeUndefined();
    expect(toolStepDetail("write", { content: "hello" }, WORKSPACE)).toBeUndefined();
    expect(toolStepDetail("read", "path", WORKSPACE)).toBeUndefined();
  });

  it("outlines commands with their purpose, never their arguments", () => {
    expect(
      toolStepDetail(
        "run_command",
        { command: "cd app && npm test -- --grep 'secret value'", description: "Run the tests" },
        WORKSPACE,
      ),
    ).toEqual({ purpose: "Run the tests", commandOutline: "cd · npm test" });
    expect(toolStepDetail("process", { action: "start", command: "npm run dev" }, WORKSPACE)).toEqual({
      commandOutline: "npm run dev",
    });
  });
});

describe("toolStepResult", () => {
  it("reads how a command ended from its details or its status line", () => {
    expect(
      toolStepResult("run_command", { content: [], details: { commandResult: { exitCode: 1, durationMs: 2400.4 } } }),
    ).toEqual({ commandResult: { exitCode: 1, durationMs: 2400 } });
    expect(commandResultOf({ content: [{ type: "text", text: "out\nCommand timed out after 30 seconds\n" }] })).toEqual(
      { stopped: "timeout" },
    );
    expect(toolStepResult("run_command", undefined)).toBeUndefined();
    expect(toolStepResult("read", { details: { commandResult: { exitCode: 0 } } })).toBeUndefined();
  });
});
