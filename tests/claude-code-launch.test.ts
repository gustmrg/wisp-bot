import { describe, expect, it, vi } from "vitest";

import {
  claudeCodeEnvironment,
  claudeCodeQueryOptions,
  claudeCodeUserMessage,
  parseClaudeCodeAuthStatus,
  WISP_TOOL_TIMEOUT_MS,
} from "../backend/claude-code/claude-code-launch.js";

const wispTools = { name: "wisp-tools-instance" };
const base = {
  workspaceDirectory: "/data/workspaces/w1",
  executable: "/home/person/.local/bin/claude",
  model: "sonnet",
  systemPrompt: "Your name is Lumen.",
  session: { id: "550e8400-e29b-41d4-a716-446655440000", resume: false },
  wispTools,
  authorize: vi.fn(async () => ({ behavior: "deny" as const, message: "no" })),
  environment: { HOME: "/home/person", PATH: "/usr/bin" },
};

describe("claudeCodeQueryOptions", () => {
  it("runs restricted with only Wisp's tools, no settings, hooks off, and the person's binary", () => {
    const options = claudeCodeQueryOptions(base);

    expect(options).toMatchObject({
      cwd: "/data/workspaces/w1",
      pathToClaudeCodeExecutable: "/home/person/.local/bin/claude",
      settingSources: [],
      strictMcpConfig: true,
      extraArgs: { restricted: null },
      settings: { disableAllHooks: true },
      permissionMode: "default",
      tools: [],
      allowedTools: ["mcp__wisp__*"],
      systemPrompt: { type: "preset", preset: "claude_code", append: "Your name is Lumen." },
    });
    expect(options.mcpServers.wisp).toEqual({
      type: "sdk",
      name: "wisp",
      instance: wispTools,
      timeout: WISP_TOOL_TIMEOUT_MS,
    });
    expect(options.canUseTool).toBe(base.authorize);
    // bypassPermissions would skip every approval; --restricted refuses it too.
    expect(JSON.stringify(options)).not.toMatch(/bypass|dangerously/i);
  });

  it("starts a session with its ID, resumes it later, and keeps none for a job run", () => {
    const id = base.session.id;
    expect(claudeCodeQueryOptions(base)).toMatchObject({ sessionId: id });
    expect(claudeCodeQueryOptions(base).resume).toBeUndefined();
    expect(claudeCodeQueryOptions({ ...base, session: { id, resume: true }, effort: "high" })).toMatchObject({
      resume: id,
      effort: "high",
    });
    const job = claudeCodeQueryOptions({ ...base, session: null });
    expect(job.persistSession).toBe(false);
    expect(job.sessionId).toBeUndefined();
    expect(job.resume).toBeUndefined();
  });

  it("rebuilds the system prompt per request and carries a replaced session's latest messages", () => {
    const options = claudeCodeQueryOptions({ ...base, recoveredContext: "user: earlier question" });

    expect(options.extraArgs).toEqual({ restricted: null, "system-prompt-snapshot": "off" });
    expect(options.systemPrompt.append).toMatch(/^Your name is Lumen\.\n\n## Earlier in this conversation\n/);
    expect(options.systemPrompt.append).toMatch(/user: earlier question$/);
  });

  it("offers Claude's WebSearch only when it is the Wisp's search provider", () => {
    expect(claudeCodeQueryOptions({ ...base, webSearch: true }).tools).toEqual(["WebSearch"]);
  });
});

describe("claudeCodeEnvironment", () => {
  it("passes no API keys, none of the Wisp server's variables, and turns claude.ai connectors off", () => {
    const environment = claudeCodeEnvironment({
      HOME: "/home/person",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      WISP_MASTER_KEY_FILE: "/etc/wisp/key",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-person",
    });

    expect(environment).toEqual({
      HOME: "/home/person",
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-person",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
  });
});

describe("claudeCodeUserMessage", () => {
  it("sends text alone, with images, or as a steering follow-up", () => {
    expect(claudeCodeUserMessage("Hello")).toEqual({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: "Hello" },
    });
    const withImage = claudeCodeUserMessage("Look", {
      images: [{ mediaType: "image/png", data: "AAAA" }],
      steer: true,
    });
    expect(withImage.message.content).toEqual([
      { type: "text", text: "Look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(withImage.priority).toBe("next");
  });
});

describe("parseClaudeCodeAuthStatus", () => {
  it("reads a subscription sign-in without keeping the account's email", () => {
    const status = parseClaudeCodeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.com",
        orgName: "Org",
        subscriptionType: "pro",
      }),
    );

    expect(status).toEqual({ signedIn: true, billing: "subscription", plan: "pro" });
  });

  it("tells an API key from a plan, and reads anything else as signed out", () => {
    expect(parseClaudeCodeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).toEqual({
      signedIn: true,
      billing: "api",
    });
    expect(parseClaudeCodeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }))).toEqual({
      signedIn: true,
      billing: "subscription",
    });
    expect(parseClaudeCodeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }))).toEqual({
      signedIn: false,
      billing: "none",
    });
    expect(parseClaudeCodeAuthStatus("Not logged in")).toEqual({ signedIn: false, billing: "none" });
  });
});
