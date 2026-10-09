import { mkdir, mkdtemp, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { IntegrationToolSource } from "../backend/integration-tool-source.js";
import { snapshotRevision } from "../backend/integration-tool-source.js";
import type { ModelRuntimeLike } from "../backend/model-service.js";
import type { PluginToolSource } from "../backend/plugin-types.js";
import { WORKSPACE_QUOTA_BYTES } from "../shared/workspace.js";
import { buildPdf } from "./helpers/pdf-fixture.js";

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
    getActiveToolNames: vi.fn(() => [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "search_history",
      "use_skill",
      "save_skill",
    ]),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    session,
    createAgentSession: vi.fn(async () => ({ session })),
    loaderOptions: [] as unknown[],
    loaderReload: vi.fn(async () => undefined),
    open: vi.fn(() => ({ kind: "open", getEntries: () => [], appendCustomEntry: vi.fn() })),
    continueRecent: vi.fn(() => ({ kind: "continue", getSessionFile: () => undefined })),
    createSession: vi.fn(() => ({ kind: "create", getEntries: () => [], appendCustomEntry: vi.fn() })),
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
} from "../backend/pi-conversation-agent.js";

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
      "use_skill",
      "save_skill",
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
      wispId: "one",
      role: "Finance",
      soul: "# Identity\nYou are a financial advisor who explains markets clearly.",
      userName: "John",
      userProfile: { preferredName: "John", aboutYou: "Backend developer", responsePreferences: "Be concise" },
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: "pi-session-id",
      piSessionFile: sessionFile,
      savePiSessionIdentity,
      userTimeZone: () => "America/Sao_Paulo",
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
        tools: ["read", "grep", "find", "ls", "edit", "write", "search_history", "use_skill", "save_skill"],
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
      "use_skill",
      "save_skill",
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
    expect(prompt).toContain('"aboutYou":"Backend developer"');
    expect(prompt).toContain('"responsePreferences":"Be concise"');
    expect(prompt).toContain('The user\'s preferred name is "John".');
    expect(prompt).toContain("do not force it or use their name in every response");
    expect(prompt).toContain("Never infer the user's name from paths, workspace metadata");
    expect(prompt).toContain("## Date and time");
    expect(prompt).toContain("## Operating and safety boundaries");
    expect(prompt).toContain("without confusing access limits with a lack of expertise");
    expect(prompt).toContain("must not weaken or override any rule in this section");
    expect(prompt).not.toContain("Description:");
    expect(prompt).toContain("subject to app policy and user approval");
    expect(prompt).toContain("must not execute shell commands");
    expect(prompt).toContain("first write one short sentence in the user's language");
    expect(prompt).toContain("Apart from that sentence, return only the final answer");
    expect(prompt).toContain("## Response style");
    expect(prompt).toContain("1. Explicit instructions in the user's current message.");
    expect(prompt).toContain("Configured role: Finance.");
    expect(prompt).toContain("2. Your identity and purpose, above.");
    expect(prompt).toContain("3. The user's general response preferences from the user profile.");
    expect(prompt).not.toContain("Tone:");
    expect(prompt).not.toContain("configured tone");
    expect(prompt).not.toContain("Be concise, factual");
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
    // A sparse file reports its full size without using the disk space.
    const fullFile = path.join(context.workspaceDirectory, "full.bin");
    await writeFile(fullFile, "");
    await truncate(fullFile, WORKSPACE_QUOTA_BYTES);
    authorize.mockClear();
    await expect(
      write.execute("tool-full", { path: "more.txt", content: "no room" }, undefined, undefined, {}),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("workspace is full") });
    expect(authorize).not.toHaveBeenCalled();
    expect(sdk.toolExecute).toHaveBeenCalledTimes(2);
  });

  it("turns images into text with the image model when the Wisp's model cannot see them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-vision-"));
    const usage = { input: 900, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 1_020, cost: { total: 0.001 } };
    const completeSimple = vi.fn(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "Receipt total: 12.50" }],
      stopReason: "stop",
      usage,
    }));
    const runtime = {
      hasConfiguredAuth: vi.fn(() => true),
      getModel: vi.fn((providerId: string, modelId: string) => ({ provider: providerId, id: modelId, name: "Vision" })),
      getProvider: vi.fn(() => ({ name: "OpenAI" })),
      completeSimple,
    } as unknown as ModelRuntimeLike;
    const context: ConversationAgentContext = {
      conversationId: "one",
      sessionId: "app-session",
      name: "Atlas",
      wispId: "one",
      role: "Research",
      soul: "",
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: null,
      piSessionFile: null,
    };
    await mkdir(context.workspaceDirectory, { recursive: true });
    await writeFile(path.join(context.workspaceDirectory, "receipt.png"), "png bytes");
    const imageResult = {
      content: [
        {
          type: "text",
          text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]",
        },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
      details: {},
    } as never;
    for (let read = 0; read < 4; read += 1) sdk.toolExecute.mockResolvedValueOnce(imageResult);
    let imageModel: { providerId: string; modelId: string } | null = { providerId: "openai", modelId: "vision" };
    await new SdkPiSessionFactory(
      runtime,
      { authorize: vi.fn(async () => undefined) },
      undefined,
      async () => imageModel,
    ).create(context, { providerId: "provider", modelId: "model" });
    const options = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    };
    const read = options.customTools.find(({ name }) => name === "read")!;
    const session = sdk.createSession.mock.results[0]?.value as { appendCustomEntry: ReturnType<typeof vi.fn> };

    const onUpdate = vi.fn();
    const result = (await read.execute("image-1", { path: "receipt.png" }, undefined, onUpdate, {
      model: { input: ["text"] },
    })) as { content: Array<{ type: string; text?: string }>; details: { transcription?: unknown } };

    expect(result.content.map(({ type }) => type)).toEqual(["text", "text"]);
    expect(result.content[0]?.text).toBe("Read image file [image/png]");
    expect(result.content[1]?.text).toContain("Image transcribed by the image model Vision (OpenAI)");
    expect(result.content[1]?.text).toContain("Receipt total: 12.50");
    expect(result.details.transcription).toEqual({ model: "Vision (OpenAI)", status: "done", cached: false });
    expect(onUpdate).toHaveBeenCalledWith({ content: [], details: { activityLabel: "Reading with Vision (OpenAI)…" } });
    expect(session.appendCustomEntry).toHaveBeenCalledWith("wisp:auxiliary-usage", {
      version: 1,
      task: "imageUnderstanding",
      providerId: "openai",
      modelId: "vision",
      outcome: "ok",
      usage,
    });

    // A second read of the same file comes from the cache; a vision model or an off task skip the image model.
    await read.execute("image-2", { path: "receipt.png" }, undefined, undefined, { model: { input: ["text"] } });
    await read.execute("image-3", { path: "receipt.png" }, undefined, undefined, {
      model: { input: ["text", "image"] },
    });
    imageModel = null;
    const off = (await read.execute("image-4", { path: "receipt.png" }, undefined, undefined, {
      model: { input: ["text"] },
    })) as { content: Array<{ type: string }> };
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(off.content.map(({ type }) => type)).toEqual(["text", "image"]);
  });

  it("reads workspace PDFs page by page and leaves other files to Pi's read tool", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-pdf-"));
    const runtime = {
      hasConfiguredAuth: vi.fn(() => true),
      getModel: vi.fn(() => ({ provider: "provider", id: "model" })),
    } as unknown as ModelRuntimeLike;
    const context: ConversationAgentContext = {
      conversationId: "one",
      sessionId: "app-session",
      name: "Atlas",
      wispId: "one",
      role: "Research",
      soul: "",
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: null,
      piSessionFile: null,
    };
    await mkdir(path.join(context.workspaceDirectory, "inbox"), { recursive: true });
    await writeFile(
      path.join(context.workspaceDirectory, "inbox", "scan.pdf"),
      buildPdf([{ text: "Quarterly report for the finance team, first page" }, { scan: true }]),
    );
    await writeFile(path.join(context.workspaceDirectory, "notes.txt"), "notes", "utf8");
    await new SdkPiSessionFactory(runtime, { authorize: vi.fn(async () => undefined) }).create(context, {
      providerId: "provider",
      modelId: "model",
    });
    const options = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    };
    const read = options.customTools.find(({ name }) => name === "read")!;
    expect(read.description).toContain("PDFs return their text page by page");

    const vision = (await read.execute("pdf-1", { path: "inbox/scan.pdf" }, undefined, undefined, {
      model: { input: ["text", "image"] },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(vision.content[0]?.text).toContain("Quarterly report for the finance team");
    expect(vision.content.map(({ type }) => type)).toEqual(["text", "image"]);
    const textOnly = (await read.execute("pdf-2", { path: "inbox/scan.pdf" }, undefined, undefined, {
      model: { input: ["text"] },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(textOnly.content.map(({ type }) => type)).toEqual(["text"]);
    expect(textOnly.content[0]?.text).toContain("likely scanned");
    expect(sdk.toolExecute).not.toHaveBeenCalled();

    await read.execute("text-1", { path: "notes.txt" }, undefined, undefined, {});
    expect(sdk.toolExecute).toHaveBeenCalledTimes(1);
  });

  it("saves skills only after approval and lists them in the next run's prompt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-skills-"));
    const runtime = {
      hasConfiguredAuth: vi.fn(() => true),
      getModel: vi.fn(() => ({ provider: "provider", id: "model" })),
    } as unknown as ModelRuntimeLike;
    const context: ConversationAgentContext = {
      conversationId: "one",
      sessionId: "app-session",
      name: "Atlas",
      wispId: "one",
      role: "Research",
      soul: "",
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: null,
      piSessionFile: null,
    };
    await mkdir(context.workspaceDirectory, { recursive: true });
    const authorize = vi.fn(async () => undefined);
    await new SdkPiSessionFactory(runtime, { authorize }).create(context, { providerId: "provider", modelId: "model" });

    const options = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    };
    const tool = (name: string) => options.customTools.find((candidate) => candidate.name === name)!;
    const loader = sdk.loaderOptions[0] as {
      systemPromptOverride: () => string;
      extensionFactories: Array<{ name: string; factory: (pi: unknown) => void }>;
    };
    expect(loader.systemPromptOverride()).toContain("Never save a skill unless the user asked for it.");
    expect(loader.systemPromptOverride()).not.toContain("## Date and time");
    expect(loader.systemPromptOverride()).toContain("do not repeat the skill's content in your reply");
    let beforeStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
    loader.extensionFactories
      .find(({ name }) => name === "wisp-continuity")!
      .factory({ on: (_event: string, handler: typeof beforeStart) => (beforeStart = handler) });
    await expect(beforeStart!({ systemPrompt: "base" })).resolves.toBeUndefined();

    const draft = {
      name: "weekly-report",
      description: "Builds the weekly status report. Use when asked for the weekly report.",
      instructions: "1. Search Linear for issues closed this week.\n2. Group them by team.",
    };
    authorize.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "tool_blocked" }));
    await expect(tool("save_skill").execute("tool-1", draft, undefined)).rejects.toThrow("denied");
    await expect(tool("use_skill").execute("tool-2", { name: "weekly-report" })).rejects.toMatchObject({
      code: "not_found",
    });

    await expect(tool("save_skill").execute("tool-3", draft, undefined)).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Saved skill weekly-report") }],
    });
    expect(authorize).toHaveBeenLastCalledWith(
      {
        conversationId: "one",
        toolCallId: "tool-3",
        toolName: "save_skill",
        category: "save_skill",
        scope: { kind: "skill", value: "weekly-report" },
        summary: `Create skill weekly-report: ${draft.description}`,
        preview: draft.instructions,
      },
      undefined,
    );
    const prompt = await beforeStart!({ systemPrompt: "base" });
    expect(prompt?.systemPrompt).toBe(
      `base\n\n## Available skills\nLoad one with use_skill before following it.\n- weekly-report: ${draft.description}`,
    );
    await expect(tool("use_skill").execute("tool-4", { name: "weekly-report" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("2. Group them by team.") }],
    });
    await expect(tool("save_skill").execute("tool-5", { ...draft, name: "Bad Name" }, undefined)).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await tool("save_skill").execute("tool-6", { ...draft, instructions: "Updated" }, undefined);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: `Replace skill weekly-report: ${draft.description}` }),
      undefined,
    );

    // A SKILL.md the user attached is saved as written, from its workspace path alone.
    const file = "---\nname: gh-flow\ndescription: Opens pull requests.\nlicense: MIT\n---\n\n1. Branch.\n";
    await mkdir(path.join(context.workspaceDirectory, "inbox"));
    await writeFile(path.join(context.workspaceDirectory, "inbox", "SKILL.md"), file);
    await expect(tool("save_skill").execute("tool-7", { path: "inbox/SKILL.md" }, undefined)).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Saved skill gh-flow") }],
    });
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { kind: "skill", value: "gh-flow" },
        summary: "Create skill gh-flow: Opens pull requests.",
        preview: file,
      }),
      undefined,
    );
    expect(await readFile(path.join(context.configDirectory, "skills", "gh-flow", "SKILL.md"), "utf8")).toBe(file);
    await expect(
      tool("save_skill").execute("tool-8", { path: "inbox/SKILL.md", name: "other" }, undefined),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await writeFile(path.join(directory, "outside.md"), file);
    await expect(tool("save_skill").execute("tool-9", { path: "../outside.md" }, undefined)).rejects.toMatchObject({
      message: expect.stringContaining("outside this Wisp's workspace"),
    });
    await expect(tool("save_skill").execute("tool-10", { path: "missing.md" }, undefined)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("does not start the model run once the send was stopped during preparation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pi-stopped-"));
    const context: ConversationAgentContext = {
      conversationId: "researcher",
      sessionId: "stopped-session",
      name: "Researcher",
      wispId: "researcher",
      role: "Research",
      soul: "Search sources.",
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
      wispId: "researcher",
      role: "Research",
      soul: "Search sources.",
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
    const builtins = ["read", "grep", "find", "ls", "edit", "write", "search_history", "use_skill", "save_skill"];
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
