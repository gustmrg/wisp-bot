import { describe, expect, it, vi } from "vitest";

import {
  bootstrapConversationState,
  LEGACY_STORAGE_KEY,
} from "../src/hooks/use-conversations.js";
import type { ConversationStateView } from "../shared/conversations.js";

const emptyState: ConversationStateView = {
  initialized: false,
  chats: {},
  statuses: {},
  recoveredCorruptState: false,
};

describe("conversation migration", () => {
  it("removes the legacy renderer state only after backend acknowledgement", async () => {
    const removeItem = vi.fn();
    const initializeConversations = vi.fn(async () => ({
      ok: true as const,
      value: { ...emptyState, initialized: true },
    }));
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        chats: {
          imported: {
            id: "imported",
            name: "Imported",
            label: "Test",
            description: "Imported legacy Wisp",
            shape: "circle",
            isCircle: false,
            notifyOnUpdatesEnabled: true,
            preview: "Ready",
            timestamp: "Now",
            messages: [],
          },
        },
      })),
      removeItem,
    };

    await bootstrapConversationState({
      getConversationState: async () => ({ ok: true, value: emptyState }),
      initializeConversations,
    }, storage);

    expect(initializeConversations).toHaveBeenCalledWith({
      chats: expect.objectContaining({ imported: expect.objectContaining({ id: "imported" }) }),
    });
    expect(removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);
  });

  it("retains the legacy renderer state when backend import fails", async () => {
    const removeItem = vi.fn();
    const storage = { getItem: vi.fn(() => null), removeItem };

    await expect(bootstrapConversationState({
      getConversationState: async () => ({ ok: true, value: emptyState }),
      initializeConversations: async () => ({
        ok: false,
        error: { code: "internal_error", message: "Write failed", retryable: false },
      }),
    }, storage)).rejects.toThrow("Write failed");

    expect(removeItem).not.toHaveBeenCalled();
  });
});
