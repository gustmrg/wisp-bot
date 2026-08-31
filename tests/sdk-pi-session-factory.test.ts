import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import type { ModelRuntimeLike } from "../electron/backend/model-service.js";

const sdk = vi.hoisted(() => {
  const session = {
    isIdle: true,
    sessionFile: "/sessions/concrete.jsonl",
    sessionId: "pi-session-id",
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => ["read", "grep", "find", "ls"]),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    session,
    createAgentSession: vi.fn(async () => ({ session })),
    loaderOptions: [] as unknown[],
    loaderReload: vi.fn(async () => undefined),
    open: vi.fn(() => ({ kind: "open" })),
    continueRecent: vi.fn(() => ({ kind: "continue", getSessionFile: () => undefined })),
    createSession: vi.fn(() => ({ kind: "create" })),
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
  createAgentSession: sdk.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: unknown) { sdk.loaderOptions.push(options); }
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
}));

import { SdkPiSessionFactory } from "../electron/backend/pi-conversation-agent.js";

describe("SdkPiSessionFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.loaderOptions.length = 0;
  });

  it("restores the persisted session with explicit model, resources, and read-only tools", async () => {
    sdk.session.getActiveToolNames.mockReturnValueOnce(["read", "grep", "find"]);
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
      label: "Research",
      description: "Inspects this workspace",
      workspaceDirectory: path.join(directory, "workspace"),
      sessionDirectory: directory,
      configDirectory: path.join(directory, "config"),
      piSessionId: "pi-session-id",
      piSessionFile: sessionFile,
      savePiSessionIdentity,
    };
    await mkdir(context.workspaceDirectory, { recursive: true });

    await new SdkPiSessionFactory(runtime).create(context, {
      providerId: "provider",
      modelId: "model",
    });

    expect(sdk.open).toHaveBeenCalledWith(sessionFile, directory, context.workspaceDirectory);
    expect(sdk.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: context.workspaceDirectory,
      agentDir: context.configDirectory,
      model,
      modelRuntime: runtime,
      tools: ["read", "grep", "find", "ls"],
      excludeTools: ["bash", "powershell", "edit", "write"],
      customTools: expect.arrayContaining([
        expect.objectContaining({ name: "read" }),
        expect.objectContaining({ name: "grep" }),
        expect.objectContaining({ name: "find" }),
        expect.objectContaining({ name: "ls" }),
      ]),
    }));
    expect(sdk.session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "find", "ls"]);
    expect(sdk.loaderOptions[0]).toEqual(expect.objectContaining({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    }));
    const prompt = (sdk.loaderOptions[0] as { systemPromptOverride: () => string }).systemPromptOverride();
    expect(prompt).toContain("Research Wisp");
    expect(prompt).toContain("must not modify files or execute shell commands");
    expect(savePiSessionIdentity).toHaveBeenCalledWith({
      sessionId: "pi-session-id",
      sessionFile: "/sessions/concrete.jsonl",
    });

    const options = sdk.createAgentSession.mock.calls[0]?.[0] as {
      customTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    };
    const read = options.customTools.find(({ name }) => name === "read")!;
    await expect(read.execute("tool-1", { path: os.tmpdir() }, undefined, undefined, {}))
      .rejects.toMatchObject({ code: "invalid_request" });
    const outsideFile = path.join(directory, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, path.join(context.workspaceDirectory, "escape.txt"));
    await expect(read.execute("tool-2", { path: "escape.txt" }, undefined, undefined, {}))
      .rejects.toMatchObject({ code: "invalid_request" });
    await writeFile(path.join(context.workspaceDirectory, "inside.txt"), "inside", "utf8");
    await expect(read.execute("tool-3", { path: "inside.txt" }, undefined, undefined, {}))
      .resolves.toBeDefined();
    expect(sdk.toolExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects missing credentials and unavailable models without selecting a fallback", () => {
    const missingAuth = {
      hasConfiguredAuth: () => false,
      getModel: () => ({ id: "fallback" }),
    } as unknown as ModelRuntimeLike;
    expect(() => new SdkPiSessionFactory(missingAuth).resolveModel({
      providerId: "provider",
      modelId: "model",
    })).toThrow(expect.objectContaining({ code: "configuration_required" }));

    const missingModel = {
      hasConfiguredAuth: () => true,
      getModel: () => undefined,
    } as unknown as ModelRuntimeLike;
    expect(() => new SdkPiSessionFactory(missingModel).resolveModel({
      providerId: "provider",
      modelId: "missing",
    })).toThrow(expect.objectContaining({ code: "model_unavailable" }));
  });
});
