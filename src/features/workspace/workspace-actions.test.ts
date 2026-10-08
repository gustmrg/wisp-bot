import { describe, expect, it } from "vitest";

import type { ChatViewCollection } from "@/chat-data";
import type { BackendError } from "../../../shared/contracts";
import { createChatIdFactory, selectActiveChatId, unseenFailures } from "@/features/workspace/workspace-actions";
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

  it("marks a failure until its conversation is opened, and again for a newer one", () => {
    const first: BackendError = { code: "unavailable", message: "Failed", retryable: true };
    const second: BackendError = { ...first, message: "Failed again" };

    expect(unseenFailures({ atlas: first, nova: undefined }, {}, "nova")).toEqual({ atlas: true });
    // Open: its own error shows in the conversation instead.
    expect(unseenFailures({ atlas: first }, {}, "atlas")).toEqual({});
    // Seen when it was opened, so leaving it does not bring the mark back.
    expect(unseenFailures({ atlas: first }, { atlas: first }, "nova")).toEqual({});
    expect(unseenFailures({ atlas: second }, { atlas: first }, "nova")).toEqual({ atlas: true });
  });
});
