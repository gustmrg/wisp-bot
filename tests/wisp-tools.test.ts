import { describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { ToolAuthorizationRequest } from "../backend/tool-authorization-broker.js";
import { createWispTools, type WispToolHost } from "../backend/wisp-tools.js";
import type { Wisp } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function stored(id: string, name: string, soul = ""): Wisp {
  return { id, name, role: "", soul, appearance: DEFAULT_WISP_APPEARANCE };
}

function setup(options: { approve?: boolean } = {}) {
  const wisps: Wisp[] = [stored("chief", "Chief"), stored("quill", "Quill", "# Quill\n\nWrites.")];
  const approvals: ToolAuthorizationRequest[] = [];
  let ids = 0;
  const host: WispToolHost = {
    list: () => wisps,
    create: async (wisp) => {
      const created = { ...wisp, id: `wisp-${++ids}` };
      wisps.push(created);
      return created;
    },
    update: async (wispId, changes) => {
      const index = wisps.findIndex(({ id }) => id === wispId);
      wisps[index] = { ...wisps[index]!, ...changes };
      return wisps[index]!;
    },
    delete: async (wispId) => {
      wisps.splice(
        wisps.findIndex(({ id }) => id === wispId),
        1,
      );
    },
  };
  const tools = createWispTools({
    host,
    context: { conversationId: "chief", wispId: "chief" } as ConversationAgentContext,
    authorizationBroker: {
      authorize: vi.fn(async (request: ToolAuthorizationRequest) => {
        approvals.push(request);
        if (options.approve === false) throw Object.assign(new Error("denied"), { code: "tool_blocked" });
      }),
    },
  }) as unknown as Tool[];
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { wisps, approvals, tool };
}

describe("Wisp tools", () => {
  it("creates a Wisp once the person approves the card that shows it", async () => {
    const { wisps, approvals, tool } = setup();
    const result = await tool("create_wisp").execute("call-1", {
      name: " Atlas ",
      role: "Research",
      soul: "# Atlas\n\nFinds sources.",
      color: "red",
      body: "drop",
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
          changes: { name: "Atlas", role: "Research", soul: "# Atlas\n\nFinds sources." },
        },
      }),
    ]);
    expect(wisps.at(-1)).toMatchObject({
      name: "Atlas",
      role: "Research",
      color: "#ff3b30",
      appearance: { ...DEFAULT_WISP_APPEARANCE, body: "drop" },
    });
    expect(result.content[0]!.text).toContain('Created the Wisp "Atlas"');
  });

  it("changes and deletes nothing the person denied", async () => {
    const { wisps, tool } = setup({ approve: false });
    await expect(tool("create_wisp").execute("call-1", { name: "Atlas", soul: "" })).rejects.toThrow("denied");
    await expect(tool("update_wisp").execute("call-2", { wisp_id: "quill", soul: "New" })).rejects.toThrow("denied");
    await expect(tool("delete_wisp").execute("call-3", { wisp_id: "quill" })).rejects.toThrow("denied");
    expect(wisps.map(({ id, soul }) => [id, soul])).toEqual([
      ["chief", ""],
      ["quill", "# Quill\n\nWrites."],
    ]);
  });

  it("shows only what an update changes, and deletes after asking", async () => {
    const { wisps, approvals, tool } = setup();
    await tool("update_wisp").execute("call-1", { wisp_id: "quill", role: "Writing" });
    expect(approvals[0]).toMatchObject({
      toolName: "update_wisp",
      wisp: { action: "update", name: "Quill", changes: { role: "Writing" } },
    });
    expect(approvals[0]!.wisp!.changes).not.toHaveProperty("soul");
    expect(wisps[1]).toMatchObject({ role: "Writing", soul: "# Quill\n\nWrites." });

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

  it("lists the Wisps, marks the caller, and reads one soul in full", async () => {
    const { tool } = setup();
    const list = (await tool("list_wisps").execute("call-1", {})).content[0]!.text;
    expect(list).toBe("Chief (you) (ID chief)\nQuill (ID quill)");
    const one = (await tool("list_wisps").execute("call-2", { wisp_id: "quill" })).content[0]!.text;
    expect(one).toContain("# Quill\n\nWrites.");
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
