import { describe, expect, it } from "vitest";

import type { Chat, ChatCollection } from "@/chat-data";
import { createChatIdFactory, selectActiveChatId } from "@/features/workspace/workspace-actions";

function wisp(id: string, systemRole?: "chief"): Chat {
  return {
    id,
    kind: "wisp",
    name: "Same display name",
    label: "Test",
    description: "Test",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
    ...(systemRole ? { systemRole } : {}),
  };
}

describe("renderer workspace actions", () => {
  it("allocates opaque IDs without reusing an ID issued earlier in the session", () => {
    const candidates = ["opaque-1", "opaque-1", "opaque-2"];
    const createId = createChatIdFactory(() => candidates.shift() ?? "opaque-3");
    const first = createId({});
    const second = createId({});
    expect(first).toBe("opaque-1");
    expect(second).toBe("opaque-2");
  });

  it("keeps a live selection and deterministically replaces a deleted selection", () => {
    const chats: ChatCollection = { first: wisp("first"), second: wisp("second") };
    expect(selectActiveChatId(chats, "second")).toBe("second");
    expect(selectActiveChatId({ first: chats.first! }, "second")).toBe("first");
    expect(selectActiveChatId({}, "second")).toBe("");
  });

  it("prefers the metadata-defined chief regardless of its ID", () => {
    const chats: ChatCollection = { first: wisp("first"), leader: wisp("leader", "chief") };
    expect(selectActiveChatId(chats, "missing")).toBe("leader");
  });
});
