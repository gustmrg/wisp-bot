import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import type { IntegrationToolSource } from "../electron/backend/integration-tool-source.js";
import { snapshotRevision } from "../electron/backend/integration-tool-source.js";
import type { ModelRuntimeLike } from "../electron/backend/model-service.js";
import type { PluginToolSource } from "../electron/backend/plugin-types.js";

const sdk = vi.hoisted(() => {
  const session = {
    isIdle: true,
    sessionFile: "/sessions/concrete.jsonl",
    sessionId: "pi-session-id",
    messages: [],
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => ["read", "grep", "find", "ls", "edit", "write", "search_history"]),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    session,
    createAgentSession: vi.fn(async () => ({ session })),
    loaderOptions: [] as unknown[],
    loaderReload: vi.fn(async () => undefined),
    open: vi.fn(() => ({ kind: "open", appendCustomEntry: vi.fn() })),
    continueRecent: vi.fn(() => ({ kind: "continue", getSessionFile: () => undefined })),
    createSession: vi.fn(() => ({ kind: "create", appendCustomEntry: vi.fn() })),
    settings: vi.fn(() => ({ kind: "settings" })),
    toolExecute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], details: {} })),
  };
});

function toolDefinition(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: sdk.toolExecute,
  };
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.84.4",
  createAgentSession: sdk.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      sdk.loaderOptions.push(options);
    }
    reload = sdk.loaderReload;
  },
  SessionManager: {
    open: sdk.open,
    continueRecent: sdk.continueRecent,
    create: sdk.createSession,
  },
  SettingsManager: { inMemory: sdk.settings },
  createReadToolDefinition: () => toolDefinition("read"),
  createGrepToolDefinition: () => toolDefinition("grep"),
  createFindToolDefinition: () => toolDefinition("find"),
  createLsToolDefinition: () => toolDefinition("ls"),
  createEditToolDefinition: () => toolDefinition("edit"),
  createWriteToolDefinition: () => toolDefinition("write"),
}));

import {
  excludeOpenRouterReasoning,
  sanitizeWorkspacePath,
  SdkPiSessionFactory,
} from "../electron/backend/pi-conversation-agent.js";

/** Adapts the legacy sync plugin tool source into the async snapshot source. */
function toToolSource(pluginTools: PluginToolSource): IntegrationToolSource {
  return {
    async getSnapshot(conversationId) {
      const definitions = pluginTools.getTools(conversationId);
      const activeNames = await pluginTools.getActiveToolNames(conversationId);
      return { definitions, metadata: [], activeNames, revision: snapshotRevision(activeNames) };
    },
  };
}

describe("SdkPiSessionFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.session.getActiveToolNames.mockImplementation(() => [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "search_history",
    ]);
    sdk.session.setActiveToolsByName.mockReset();
    sdk.loaderOptions.length = 0;
  });

  it("restores the persisted session with explicit model, resources, and policy-wrapped tools", async () => {
    sdk.session.getActiveToolNames.mockReturnValueOnce(["read", "grep", "find", "ls", "edit"]);
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-sdk-"));
    const sessionFile = path.join(directory, "persisted.jsonl");
    await writeFile(sessionFile, "session", "utf8");
    const savePiSessionIdentity = vi.fn(async () => undefined);
    const model = { provider: "provider", id: "model" };
    const runtime = {
      hasConfiguredAuth: vi.fn(() => true),
      getModel: vi.fn(() => model),
    } as unknown as ModelRuntimeLike;
    const context: ConversationAgentContext = {
      conversationId: "one",
      sessionId: "app-session",
      name: "Research Wisp",
      label: "Finance",
      description: "You are a financial advisor who explains markets clearly.",
      userName: "John",
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: "pi-session-id",
      piSessionFile: sessionFile,
      savePiSessionIdentity,
    };
    await mkdir(context.workspaceDirectory, { recursive: true });

    const authorize = vi.fn(async () => undefined);
    await new SdkPiSessionFactory(runtime, { authorize }).create(context, {
      providerId: "provider",
      modelId: "model",
    });

    expect(sdk.open).toHaveBeenCalledWith(sessionFile, directory, context.workspaceDirectory);
    expect(sdk.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: context.workspaceDirectory,
        agentDir: context.configDirectory,
        model,
        modelRuntime: runtime,
        tools: ["read", "grep", "find", "ls", "edit", "write", "search_history"],
        excludeTools: ["bash", "powershell"],
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: "read" }),
          expect.objectContaining({ name: "grep" }),
          expect.objectContaining({ name: "find" }),
          expect.objectContaining({ name: "ls" }),
          expect.objectContaining({ name: "edit" }),
          expect.objectContaining({ name: "write" }),
        ]),
      }),
    );
    expect(sdk.session.setActiveToolsByName).toHaveBeenCalledWith([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "search_history",
    ]);
    expect(sdk.loaderOptions[0]).toEqual(
      expect.objectContaining({
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: expect.arrayContaining([expect.objectContaining({ hidden: true })]),
      }),
    );
    const prompt = (sdk.loaderOptions[0] as { systemPromptOverride: () => string }).systemPromptOverride();
    expect(prompt).toContain("You are Research Wisp, a Wisp.");
    expect(prompt).not.toContain("a Wisp coding agent.");
    expect(prompt).toContain("## Identity and purpose / SOUL");
    expect(prompt).toContain("authoritative definition of your identity, expertise");
    expect(prompt).toContain("You are a financial advisor who explains markets clearly.");
    expect(prompt).toContain("Never dismiss it as fictional");
    expect(prompt).toContain("supersedes conflicting identity statements in the conversation history");
    expect(prompt).toContain("## Self-description");
    expect(prompt).toContain("directly and positively, without explaining how they were supplied");
    expect(prompt).toContain("Available workspace tools do not define your profession");
    expect(prompt).not.toContain("UI metadata");
    expect(prompt).not.toContain("coding agent");
    expect(prompt).toContain("Mention an operational limitation only when it materially affects the user's request");
    expect(prompt).toContain("## Relationship with the user");
    expect(prompt).toContain('The user\'s preferred name is "John".');
    expect(prompt).toContain("do not force it or use their name in every response");
    expect(prompt).toContain("Never infer the user's name from paths, workspace metadata");
    expect(prompt).toContain("## Operating and safety boundaries");
    expect(prompt).toContain("without confusing access limits with a lack of expertise");
    expect(prompt).toContain("must not weaken or override any rule in this section");
    expect(prompt).not.toContain("Description:");
    expect(prompt).toContain("subject to app policy and user approval");
    expect(prompt).toContain("must not execute shell commands");
    expect(prompt).toContain("Return only the final answer");
    expect(savePiSessionIdentity).toHaveBeenCalledWith({
      sessionId: "pi-session-id",
      sessionFile: "/sessions/concrete.jsonl",
    });

    const options = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    };
    const read = options.customTools.find(({ name }) => name === "read")!;
    await expect(read.execute("tool-1", { path: os.tmpdir() }, undefined, undefined, {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    const outsideFile = path.join(directory, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, path.join(context.workspaceDirectory, "escape.txt"));
    await expect(read.execute("tool-2", { path: "escape.txt" }, undefined, undefined, {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    await writeFile(path.join(context.workspaceDirectory, "inside.txt"), "inside", "utf8");
    sdk.toolExecute.mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(70_000) }], details: {} });
    const boundedResult = await read.execute("tool-3", { path: "inside.txt" }, undefined, undefined, {});
    expect((boundedResult as { content: Array<{ text: string }> }).content[0]?.text.length).toBeLessThanOrEqual(64_000);
    const write = options.customTools.find(({ name }) => name === "write")!;
    await expect(
      write.execute("tool-4", { path: "new.txt", content: "safe" }, undefined, undefined, {}),
    ).resolves.toBeDefined();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "one",
        toolCallId: "tool-4",
        category: "create_file",
        summary: "Create new.txt",
      }),
      undefined,
    );
    expect(JSON.stringify(authorize.mock.calls)).not.toContain("safe");
    await expect(
      write.execute("tool-large", { path: "large.txt", content: "x".repeat(1_000_001) }, undefined, undefined, {}),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const outsideDirectory = path.join(directory, "outside-directory");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(context.workspaceDirectory, "escape-directory"));
    await expect(
      write.execute("tool-5", { path: "escape-directory/new.txt", content: "blocked" }, undefined, undefined, {}),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await symlink(
      path.join(directory, "missing-outside-directory"),
      path.join(context.workspaceDirectory, "broken-escape"),
    );
    await expect(
      write.execute("tool-6", { path: "broken-escape/new.txt", content: "blocked" }, undefined, undefined, {}),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(sdk.toolExecute).toHaveBeenCalledTimes(2);
  });

  it("does not start the model run once the send was stopped during preparation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-stopped-"));
    const context: ConversationAgentContext = {
      conversationId: "researcher",
      sessionId: "stopped-session",
      name: "Researcher",
      label: "Research",
      description: "Search sources.",
      workspaceDirectory: directory,
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: null,
      piSessionFile: null,
    };
    const runtime = {
      hasConfiguredAuth: () => true,
      getModel: () => ({ provider: "provider", id: "model" }),
    } as unknown as ModelRuntimeLike;
    const session = await new SdkPiSessionFactory(runtime).create(context, {
      providerId: "provider",
      modelId: "model",
    });
    const stopped = new AbortController();
    stopped.abort();

    await expect(
      session.prompt("Too late", { expandPromptTemplates: false, signal: stopped.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sdk.session.prompt).not.toHaveBeenCalled();

    await session.prompt("Go ahead", { expandPromptTemplates: false, signal: new AbortController().signal });
    // Pi receives its own options only; the cancellation signal stays in the adapter.
    expect(sdk.session.prompt).toHaveBeenCalledWith("Go ahead", { expandPromptTemplates: false });
  });

  it("activates only registered tools granted to this Wisp and refreshes grants before prompts and after reload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-plugins-"));
    const context: ConversationAgentContext = {
      conversationId: "researcher",
      sessionId: "plugin-session",
      name: "Researcher",
      label: "Research",
      description: "Search sources.",
      workspaceDirectory: directory,
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
    };
    const runtime = {
      hasConfiguredAuth: () => true,
      getModel: () => ({ provider: "provider", id: "model" }),
    } as unknown as ModelRuntimeLike;
    const grantNames: Record<string, string[]> = {
      researcher: ["web_search", "web_search", "bash", "invented_tool", "linear_update_issue"],
      coordinator: ["linear_get_issue"],
    };
    const pluginTools: PluginToolSource = {
      getTools: vi.fn(() => [
        toolDefinition("web_search"),
        toolDefinition("linear_get_issue"),
        toolDefinition("bash"),
      ]) as PluginToolSource["getTools"],
      getActiveToolNames: vi.fn(async (id: string) => grantNames[id] ?? []),
    };
    const factory = new SdkPiSessionFactory(runtime, undefined, toToolSource(pluginTools));
    const session = await factory.create(context, { providerId: "provider", modelId: "model" });
    const builtins = ["read", "grep", "find", "ls", "edit", "write", "search_history"];
    expect(sdk.createAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tools: [...builtins, "web_search", "linear_get_issue"],
        excludeTools: ["bash", "powershell"],
      }),
    );
    expect(sdk.session.setActiveToolsByName).toHaveBeenLastCalledWith([...builtins, "web_search"]);
    const customTools = (sdk.createAgentSession.mock.calls[0]?.[0] as { customTools: { name: string }[] }).customTools;
    expect(customTools.map(({ name }) => name)).not.toContain("bash");
    expect(customTools.map(({ name }) => name)).toContain("linear_get_issue");

    grantNames.researcher = ["linear_get_issue"];
    await session.prompt("Read the issue", { expandPromptTemplates: false });
    expect(sdk.session.setActiveToolsByName).toHaveBeenLastCalledWith([...builtins, "linear_get_issue"]);
    expect(sdk.session.setActiveToolsByName.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sdk.session.prompt.mock.invocationCallOrder.at(-1)!,
    );

    sdk.session.getActiveToolNames.mockReturnValue([...builtins, "linear_get_issue"]);
    grantNames.researcher = [];
    await session.reload();
    expect(sdk.session.setActiveToolsByName).toHaveBeenLastCalledWith(builtins);
    session.dispose();

    await factory.create({ ...context, conversationId: "coordinator" }, { providerId: "provider", modelId: "model" });
    expect(sdk.createAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ tools: [...builtins, "web_search", "linear_get_issue"] }),
    );
    expect(pluginTools.getActiveToolNames).toHaveBeenCalledWith("researcher");
    expect(pluginTools.getActiveToolNames).toHaveBeenCalledWith("coordinator");
  });

  it("rejects missing credentials and unavailable models without selecting a fallback", () => {
    const missingAuth = {
      hasConfiguredAuth: () => false,
      getModel: () => ({ id: "fallback" }),
    } as unknown as ModelRuntimeLike;
    expect(() =>
      new SdkPiSessionFactory(missingAuth).resolveModel({
        providerId: "provider",
        modelId: "model",
      }),
    ).toThrow(expect.objectContaining({ code: "configuration_required" }));

    const missingModel = {
      hasConfiguredAuth: () => true,
      getModel: () => undefined,
    } as unknown as ModelRuntimeLike;
    expect(() =>
      new SdkPiSessionFactory(missingModel).resolveModel({
        providerId: "provider",
        modelId: "missing",
      }),
    ).toThrow(expect.objectContaining({ code: "model_unavailable" }));
  });

  it("applies the default output limit and allows a validated model override", () => {
    const catalogModel = {
      provider: "openrouter",
      id: "minimax/minimax-m3:free",
      maxTokens: 943_718,
    };
    const runtime = {
      hasConfiguredAuth: () => true,
      getModel: () => catalogModel,
    } as unknown as ModelRuntimeLike;

    const factory = new SdkPiSessionFactory(runtime);
    const resolved = factory.resolveModel({
      providerId: "openrouter",
      modelId: "minimax/minimax-m3:free",
    });

    expect(resolved.maxTokens).toBe(32_768);
    expect(resolved).not.toBe(catalogModel);
    expect(catalogModel.maxTokens).toBe(943_718);
    expect(
      factory.resolveModel({
        providerId: "openrouter",
        modelId: "minimax/minimax-m3:free",
        maxOutputTokens: 131_072,
      }).maxTokens,
    ).toBe(131_072);
  });

  it("excludes reasoning from OpenRouter responses without changing other provider payloads", () => {
    const payload = { model: "model", reasoning: { effort: "none" }, messages: [] };

    expect(excludeOpenRouterReasoning(payload, "openrouter")).toEqual({
      model: "model",
      include_reasoning: false,
      reasoning: { effort: "none", enabled: false, exclude: true },
      messages: [],
    });
    expect(excludeOpenRouterReasoning(payload, "anthropic")).toBe(payload);
  });

  it("removes the absolute workspace path from nested provider payloads", () => {
    const workspaceDirectory = "/home/gustavo/.config/wisp-bot/backend/workspaces/session-id";
    const payload = {
      messages: [
        {
          role: "system",
          content: `You are a Wisp.\nCurrent working directory: ${workspaceDirectory}`,
        },
        {
          role: "user",
          content: [{ type: "text", text: `Inspect ${workspaceDirectory}/notes.txt` }],
        },
      ],
    };

    const sanitized = sanitizeWorkspacePath(payload, workspaceDirectory);

    expect(JSON.stringify(sanitized)).not.toContain("/home/gustavo");
    expect(sanitized).toEqual({
      messages: [
        { role: "system", content: "You are a Wisp.\nUse relative paths for workspace tools." },
        { role: "user", content: [{ type: "text", text: "Inspect ./notes.txt" }] },
      ],
    });
    expect(JSON.stringify(sanitized)).not.toContain("<workspace>");
    expect(JSON.stringify(payload)).toContain(workspaceDirectory);
  });
});
