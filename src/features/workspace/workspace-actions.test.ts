import { describe, expect, it } from "vitest";

import type { ChatViewCollection } from "@/chat-data";
import { createChatIdFactory, selectActiveChatId } from "@/features/workspace/workspace-actions";
import { wispChatView } from "@/test/chat-fixtures";

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
    const chats: ChatViewCollection = { first: wispChatView("first"), second: wispChatView("second") };
    expect(selectActiveChatId(chats, "second")).toBe("second");
    expect(selectActiveChatId({ first: chats.first! }, "second")).toBe("first");
    expect(selectActiveChatId({}, "second")).toBe("");
  });
});
