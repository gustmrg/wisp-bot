import { describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { ToolAuthorizationRequest } from "../backend/tool-authorization-broker.js";
import {
  createWispTools,
  WISP_TOOL_NAMES,
  type WispCircleSummary,
  type WispCreateOptions,
  type WispSettings,
  type WispToolHost,
  type WispUpdateOptions,
} from "../backend/wisp-tools.js";
import type { ModelSelection, WispFallback } from "../shared/contracts.js";
import type { Wisp } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

function stored(id: string, name: string, soul = "", extra: Partial<Wisp> = {}): Wisp {
  return { id, name, role: "", soul, appearance: DEFAULT_WISP_APPEARANCE, ...extra };
}

const SONNET = { provider: "Anthropic", model: "Claude Sonnet" };

function setup(
  options: {
    approve?: boolean;
    appModel?: boolean;
    circles?: WispCircleSummary[];
    quillDetails?: Partial<WispSettings>;
    askReply?: (message: string, signal?: AbortSignal) => Promise<string>;
  } = {},
) {
  const wisps: Wisp[] = [
    stored("chief", "Chief", "", { color: "#885cf5" }),
    stored("quill", "Quill", "# Quill\n\nWrites.", { role: "Editor", color: "#3c82f6" }),
  ];
  const circles: WispCircleSummary[] = [...(options.circles ?? [])];
  const approvals: ToolAuthorizationRequest[] = [];
  const modelOverrides = new Map<string, ModelSelection | null>([
    ["quill", { providerId: "openai", modelId: "gpt-5", thinkingLevel: "high" }],
  ]);
  const fallbacks = new Map<string, WispFallback>([["quill", { providerId: "anthropic", modelId: "claude-haiku" }]]);
  const askCalls: Array<{ targetWispId: string; message: string }> = [];
  let ids = 0;
  let circleIds = 0;
  const host: WispToolHost = {
    list: () => wisps,
    create: async (wisp, createOptions?: WispCreateOptions) => {
      const created = { ...wisp, id: `wisp-${++ids}` };
      wisps.push(created);
      if (createOptions?.model !== undefined) modelOverrides.set(created.id, createOptions.model);
      if (createOptions?.fallback !== undefined) fallbacks.set(created.id, createOptions.fallback);
      return created;
    },
    update: async (wispId, changes, updateOptions?: WispUpdateOptions) => {
      const index = wisps.findIndex(({ id }) => id === wispId);
      wisps[index] = { ...wisps[index]!, ...changes };
      if (updateOptions?.model !== undefined) modelOverrides.set(wispId, updateOptions.model);
      if (updateOptions?.fallback !== undefined) fallbacks.set(wispId, updateOptions.fallback);
      return wisps[index]!;
    },
    delete: async (wispId) => {
      wisps.splice(
        wisps.findIndex(({ id }) => id === wispId),
        1,
      );
    },
    settings: async (wispId, settingsOptions) => {
      const wispCircles = circles
        .filter((circle) => circle.memberIds.includes(wispId))
        .map((circle) => ({ id: circle.id, name: circle.name, isLead: circle.memberIds[0] === wispId }));
      if (wispId === "quill") {
        const base: WispSettings = {
          model: { provider: "OpenAI", model: "GPT-5", thinkingLevel: "high" },
          modelSource: "wisp",
          modelOverride: modelOverrides.get("quill") ?? null,
          fallback: { provider: "Anthropic", model: "Claude Haiku" },
          circles: wispCircles,
          capabilities: { commands: true, localNetwork: false, browser: true },
        };
        if (!settingsOptions?.detail) return base;
        return {
          ...base,
          skills: [{ name: "copy-edit", description: "Edits drafts for clarity." }],
          jobs: [{ title: "Daily digest", schedule: "Every day at 09:00", paused: false }],
          capabilities: {
            commands: true,
            localNetwork: false,
            browser: true,
            workspaceUsedBytes: 2 * 1024 * 1024,
            workspaceQuotaBytes: 512 * 1024 * 1024,
            workspaceUnlimited: false,
          },
          integrations: {
            plugins: [{ name: "Linear", access: "write" }],
            mcpServers: [{ name: "GitHub", access: "use_with_approval" }],
          },
          ...options.quillDetails,
        };
      }
      return {
        model: options.appModel === false ? null : SONNET,
        modelSource: "app",
        modelOverride: modelOverrides.get(wispId) ?? null,
        fallback: null,
        circles: wispCircles,
      };
    },
    validateModel: async (selection) => {
      if (selection.providerId === "bad-provider") {
        throw new WispBackendError("invalid_configuration", "The selected provider and model are not available.");
      }
      return {
        provider: selection.providerId === "openai" ? "OpenAI" : selection.providerId,
        model: selection.modelId === "gpt-5" ? "GPT-5" : selection.modelId,
        ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
      };
    },
    validateFallback: async (selection, primary) => {
      if (primary?.providerId === selection.providerId) {
        throw new WispBackendError("invalid_configuration", "Choose a fallback model from another provider.");
      }
      return {
        provider: selection.providerId === "anthropic" ? "Anthropic" : selection.providerId,
        model: selection.modelId === "claude-haiku" ? "Claude Haiku" : selection.modelId,
      };
    },
    listCircles: async () => [...circles],
    createCircle: async (circle) => {
      const created: WispCircleSummary = { ...circle, id: `circle-${++circleIds}`, commandsEnabled: false };
      circles.push(created);
      return created;
    },
    updateCircle: async (circleId, changes) => {
      const index = circles.findIndex(({ id }) => id === circleId);
      circles[index] = { ...circles[index]!, ...changes };
      return circles[index]!;
    },
    ask: async (request, signal) => {
      askCalls.push({ targetWispId: request.targetWispId, message: request.message });
      if (options.askReply) return options.askReply(request.message, signal);
      return `Answer to: ${request.message}`;
    },
  };
  const tools = createWispTools({
    host,
    context: {
      conversationId: "chief",
      wispId: "chief",
      name: "Chief",
      role: "Team builder",
    } as ConversationAgentContext,
    authorizationBroker: {
      authorize: vi.fn(async (request: ToolAuthorizationRequest) => {
        approvals.push(request);
        if (options.approve === false) throw Object.assign(new Error("denied"), { code: "tool_blocked" });
      }),
    },
  }) as unknown as Tool[];
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { wisps, circles, approvals, modelOverrides, fallbacks, askCalls, tool };
}

describe("Wisp tools", () => {
  it("exposes all expected Wisp and circle tools", () => {
    expect([...WISP_TOOL_NAMES].sort()).toEqual([
      "ask_wisp",
      "create_circle",
      "create_wisp",
      "delete_wisp",
      "list_circles",
      "list_wisps",
      "update_circle",
      "update_wisp",
    ]);
  });

  it("creates a Wisp with model, fallback, memory_off, and appearance once approved", async () => {
    const { wisps, approvals, modelOverrides, fallbacks, tool } = setup();
    const result = await tool("create_wisp").execute("call-1", {
      name: " Atlas ",
      role: "Research",
      soul: "# Atlas\n\nFinds sources.",
      color: "red",
      body: "drop",
      memory_off: true,
      model: { provider: "openai", model: "gpt-5", thinking_level: "medium" },
      fallback: { provider: "anthropic", model: "claude-haiku" },
    });

    expect(approvals).toEqual([
      expect.objectContaining({
        conversationId: "chief",
        toolCallId: "call-1",
        toolName: "create_wisp",
        category: "manage_wisp",
        scope: { kind: "wisp", value: "Atlas" },
        wisp: {
          action: "create",
          name: "Atlas",
          changes: {
            name: "Atlas",
            role: "Research",
            soul: "# Atlas\n\nFinds sources.",
            color: "red",
            body: "drop",
            memory: "off",
            model: "GPT-5 from OpenAI (reasoning: medium)",
            fallback: "Claude Haiku from Anthropic",
          },
        },
      }),
    ]);
    const created = wisps.at(-1)!;
    expect(created).toMatchObject({
      name: "Atlas",
      role: "Research",
      color: "#ff3b30",
      memoryOff: true,
      appearance: { ...DEFAULT_WISP_APPEARANCE, body: "drop" },
    });
    expect(modelOverrides.get(created.id)).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    });
    expect(fallbacks.get(created.id)).toEqual({ providerId: "anthropic", modelId: "claude-haiku" });
    expect(result.content[0]!.text).toContain('Created the Wisp "Atlas"');
  });

  it("validates model and fallback before showing an approval card", async () => {
    const { approvals, tool } = setup();
    await expect(
      tool("create_wisp").execute("call-1", {
        name: "Bad",
        soul: "",
        model: { provider: "bad-provider", model: "x" },
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      tool("create_wisp").execute("call-2", {
        name: "Same",
        soul: "",
        model: { provider: "openai", model: "gpt-5" },
        fallback: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(approvals).toEqual([]);
  });

  it("changes and deletes nothing the person denied", async () => {
    const { wisps, circles, tool } = setup({ approve: false });
    await expect(tool("create_wisp").execute("call-1", { name: "Atlas", soul: "" })).rejects.toThrow("denied");
    await expect(tool("update_wisp").execute("call-2", { wisp_id: "quill", soul: "New" })).rejects.toThrow("denied");
    await expect(tool("delete_wisp").execute("call-3", { wisp_id: "quill" })).rejects.toThrow("denied");
    await expect(
      tool("create_circle").execute("call-4", { name: "Editorial", member_ids: ["chief", "quill"] }),
    ).rejects.toThrow("denied");
    expect(wisps.map(({ id, soul }) => [id, soul])).toEqual([
      ["chief", ""],
      ["quill", "# Quill\n\nWrites."],
    ]);
    expect(circles).toEqual([]);
  });

  it("updates model, fallback, memory_off, and role with exact approval details, and deletes after asking", async () => {
    const { wisps, approvals, modelOverrides, fallbacks, tool } = setup();
    await tool("update_wisp").execute("call-1", {
      wisp_id: "quill",
      role: "Writing",
      memory_off: true,
      model: null,
      fallback: "none",
    });
    expect(approvals[0]).toMatchObject({
      toolName: "update_wisp",
      wisp: {
        action: "update",
        name: "Quill",
        changes: {
          role: "Writing",
          memory: "off",
          model: "App default",
          fallback: "None",
        },
      },
    });
    expect(approvals[0]!.wisp!.changes).not.toHaveProperty("soul");
    expect(wisps[1]).toMatchObject({ role: "Writing", memoryOff: true, soul: "# Quill\n\nWrites." });
    expect(modelOverrides.get("quill")).toBeNull();
    expect(fallbacks.get("quill")).toBe("off");

    await tool("delete_wisp").execute("call-2", { wisp_id: "quill" });
    expect(approvals[1]).toMatchObject({ toolName: "delete_wisp", wisp: { action: "delete", name: "Quill" } });
    expect(wisps.map(({ id }) => id)).toEqual(["chief"]);
  });

  it("never changes or deletes the Wisp that calls it, without asking", async () => {
    const { approvals, tool } = setup();
    await expect(tool("update_wisp").execute("call-1", { wisp_id: "chief", name: "Boss" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(tool("delete_wisp").execute("call-2", { wisp_id: "chief" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(tool("delete_wisp").execute("call-3", { wisp_id: "nobody" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(approvals).toEqual([]);
  });

  it("lists Wisps with compact hints and reads full non-secret metadata in detail mode", async () => {
    const { wisps, tool } = setup({
      circles: [
        {
          id: "circle-1",
          name: "Newsroom",
          description: "Editorial collaboration",
          memberIds: ["quill", "chief"],
          responder: "auto",
          commandsEnabled: true,
        },
      ],
    });
    wisps[1] = { ...wisps[1]!, memoryOff: true };

    const list = (await tool("list_wisps").execute("call-1", {})).content[0]!.text;
    expect(list).toBe(
      [
        "Chief (you) (ID chief). Model: Claude Sonnet from Anthropic (the app's default). Circles: 1",
        "Quill (ID quill): Editor. Model: GPT-5 from OpenAI (its own). Circles: 1. Capabilities: commands, browser. Memory: off",
      ].join("\n"),
    );

    const one = (await tool("list_wisps").execute("call-2", { wisp_id: "quill" })).content[0]!.text;
    expect(one).toBe(
      [
        "Quill (ID quill): Editor",
        "Appearance: color blue (#3c82f6), body round",
        "Model: GPT-5 from OpenAI (its own)",
        "Reasoning: high",
        "Fallback model: Claude Haiku from Anthropic",
        "Memory: off",
        "Circles: Newsroom (ID circle-1, lead)",
        "Skills:",
        "- copy-edit: Edits drafts for clarity.",
        "Scheduled jobs:",
        "- Daily digest — Every day at 09:00 (enabled)",
        "Capabilities: commands enabled, local network blocked, browser enabled",
        "Workspace: 2.0 MiB used of 512 MiB",
        "Plugins: Linear (write)",
        "MCP servers: GitHub (use_with_approval)",
        "Soul:",
        "# Quill\n\nWrites.",
      ].join("\n"),
    );
  });

  it("says when a Wisp has no model or fallback configured", async () => {
    const { tool } = setup({ appModel: false });
    const one = (await tool("list_wisps").execute("call-1", { wisp_id: "chief" })).content[0]!.text;
    expect(one).toContain("Model: none configured");
    expect(one).toContain("Fallback model: none");
    expect(one).toContain("Memory: on");
    expect(one).toContain("Appearance: color violet (#885cf5), body round");
    expect(one).toContain("Soul:\n(empty)");
  });

  it("lists circles with members, lead, responder mode, and commands status", async () => {
    const { tool } = setup({
      circles: [
        {
          id: "circle-1",
          name: "Engineering",
          description: "Build features together",
          memberIds: ["chief", "quill"],
          responder: "auto",
          commandsEnabled: true,
        },
      ],
    });
    const output = (await tool("list_circles").execute("call-1", {})).content[0]!.text;
    expect(output).toBe(
      [
        "Engineering (ID circle-1)",
        "Description: Build features together",
        "Members: Chief (ID chief, lead), Quill (ID quill)",
        "Responder: auto",
        "Commands: enabled",
      ].join("\n"),
    );

    const empty = setup();
    expect((await empty.tool("list_circles").execute("call-2", {})).content[0]!.text).toBe("There are no circles yet.");
  });

  it("creates and updates circles through manage_wisp approval cards with validation and deduplication", async () => {
    const { circles, approvals, tool } = setup();

    // Rejects unknown member or invalid lead before asking.
    await expect(
      tool("create_circle").execute("call-bad-1", { name: "Bad", member_ids: ["chief", "missing"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      tool("create_circle").execute("call-bad-2", { name: "Bad", member_ids: ["chief"], lead_id: "quill" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(approvals).toEqual([]);

    const created = await tool("create_circle").execute("call-1", {
      name: "Writers",
      description: "Draft and edit docs",
      member_ids: ["chief", "quill", "chief"],
      lead_id: "quill",
      responder: "auto",
    });
    expect(created.content[0]!.text).toContain('Created the circle "Writers"');
    expect(circles[0]).toMatchObject({
      name: "Writers",
      description: "Draft and edit docs",
      memberIds: ["quill", "chief"],
      responder: "auto",
    });
    expect(approvals[0]).toMatchObject({
      toolName: "create_circle",
      category: "manage_wisp",
      scope: { kind: "wisp", value: "Writers" },
      wisp: {
        target: "circle",
        action: "create",
        name: "Writers",
        changes: {
          name: "Writers",
          description: "Draft and edit docs",
          members: ["Quill", "Chief"],
          lead: "Quill",
          responder: "auto",
        },
      },
    });

    await tool("update_circle").execute("call-2", {
      circle_id: circles[0]!.id,
      name: "Editorial",
      lead_id: "chief",
      responder: "lead",
    });
    expect(circles[0]).toMatchObject({
      name: "Editorial",
      memberIds: ["chief", "quill"],
      responder: "lead",
    });
    expect(approvals[1]).toMatchObject({
      toolName: "update_circle",
      category: "manage_wisp",
      wisp: {
        target: "circle",
        action: "update",
        name: "Writers",
        changes: {
          name: "Editorial",
          lead: "Chief",
          responder: "lead",
        },
      },
    });
  });

  it("consults another Wisp with ask_wisp and rejects self-calls and unknown targets", async () => {
    const { askCalls, tool } = setup();

    await expect(tool("ask_wisp").execute("call-1", { wisp_id: "chief", message: "Hi" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(tool("ask_wisp").execute("call-2", { wisp_id: "ghost", message: "Hi" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(askCalls).toEqual([]);

    const result = await tool("ask_wisp").execute("call-3", {
      wisp_id: "quill",
      message: "Review this intro paragraph.",
    });
    expect(askCalls).toEqual([{ targetWispId: "quill", message: "Review this intro paragraph." }]);
    expect(result.content[0]!.text).toBe("Reply from Quill (ID quill):\n\nAnswer to: Review this intro paragraph.");
  });

  it("rejects a color or body outside the palette before asking", async () => {
    const { approvals, tool } = setup();
    await expect(
      tool("create_wisp").execute("call-1", { name: "A", soul: "", color: "#123456" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(tool("create_wisp").execute("call-2", { name: "A", soul: "", body: "star" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(approvals).toEqual([]);
  });
});
