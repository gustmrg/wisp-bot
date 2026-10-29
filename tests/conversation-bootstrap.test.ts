import { describe, expect, it, vi } from "vitest";

import { bootstrapConversationState } from "../src/hooks/use-conversations.js";
import type { ConversationStateView } from "../shared/conversations.js";

const emptyState: ConversationStateView = {
  initialized: false,
  chats: {},
  statuses: {},
  agentEventSequence: 0,
  pendingToolApprovals: [],
  recoveredCorruptState: false,
};

describe("conversation bootstrap", () => {
  it("sets up a new environment's store once, with no conversations", async () => {
    const initializeConversations = vi.fn(async () => ({
      ok: true as const,
      value: { ...emptyState, initialized: true },
    }));

    const state = await bootstrapConversationState({
      getConversationState: async () => ({ ok: true, value: emptyState }),
      initializeConversations,
    });

    expect(initializeConversations).toHaveBeenCalledWith();
    expect(state.initialized).toBe(true);
  });

  it("leaves a store that is already set up as it is", async () => {
    const initializeConversations = vi.fn();
    const ready = { ...emptyState, initialized: true };

    await expect(
      bootstrapConversationState({
        getConversationState: async () => ({ ok: true, value: ready }),
        initializeConversations,
      }),
    ).resolves.toBe(ready);
    expect(initializeConversations).not.toHaveBeenCalled();
  });

  it("reports a backend that cannot set up the store", async () => {
    await expect(
      bootstrapConversationState({
        getConversationState: async () => ({ ok: true, value: emptyState }),
        initializeConversations: async () => ({
          ok: false,
          error: { code: "internal_error", message: "The store is unavailable.", retryable: true },
        }),
      }),
    ).rejects.toThrow("The store is unavailable.");
  });
});
