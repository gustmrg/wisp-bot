import { describe, expect, it, vi } from "vitest";

import { bootstrapConversationState, LEGACY_STORAGE_KEY } from "../src/hooks/use-conversations.js";
import type { ConnectionsView } from "../shared/connections.js";
import type { ConversationStateView } from "../shared/conversations.js";

const emptyState: ConversationStateView = {
  initialized: false,
  chats: {},
  statuses: {},
  agentEventSequence: 0,
  pendingToolApprovals: [],
  recoveredCorruptState: false,
};

function connections(activeId: string): () => Promise<{ ok: true; value: ConnectionsView }> {
  return async () => ({
    ok: true,
    value: {
      activeId,
      profiles: [],
      status: { profileId: activeId, phase: activeId === "local" ? "local" : "connected", epoch: 1 },
      secureStorageAvailable: true,
    },
  });
}

describe("conversation migration", () => {
  it("initializes a new installation without demo conversations", async () => {
    const initializeConversations = vi.fn(async () => ({
      ok: true as const,
      value: { ...emptyState, initialized: true },
    }));

    await bootstrapConversationState(
      {
        getConversationState: async () => ({ ok: true, value: emptyState }),
        getConnections: connections("local"),
        initializeConversations,
      },
      { getItem: () => null, removeItem: vi.fn() },
    );

    expect(initializeConversations).toHaveBeenCalledWith({ chats: {} });
  });

  it("removes the legacy renderer state only after backend acknowledgement", async () => {
    const removeItem = vi.fn();
    const initializeConversations = vi.fn(async () => ({
      ok: true as const,
      value: { ...emptyState, initialized: true },
    }));
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({
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
        }),
      ),
      removeItem,
    };

    await bootstrapConversationState(
      {
        getConversationState: async () => ({ ok: true, value: emptyState }),
        getConnections: connections("local"),
        initializeConversations,
      },
      storage,
    );

    expect(initializeConversations).toHaveBeenCalledWith({
      chats: expect.objectContaining({ imported: expect.objectContaining({ id: "imported" }) }),
    });
    expect(removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);
  });

  it("retains the legacy renderer state when backend import fails", async () => {
    const removeItem = vi.fn();
    const storage = { getItem: vi.fn(() => null), removeItem };

    await expect(
      bootstrapConversationState(
        {
          getConversationState: async () => ({ ok: true, value: emptyState }),
          getConnections: connections("local"),
          initializeConversations: async () => ({
            ok: false,
            error: { code: "internal_error", message: "Write failed", retryable: false },
          }),
        },
        storage,
      ),
    ).rejects.toThrow("Write failed");

    expect(removeItem).not.toHaveBeenCalled();
  });

  it("leaves the legacy renderer state out of a server's first run", async () => {
    const removeItem = vi.fn();
    const getItem = vi.fn(() => JSON.stringify({ chats: { imported: { id: "imported" } } }));
    const initializeConversations = vi.fn(async () => ({
      ok: true as const,
      value: { ...emptyState, initialized: true },
    }));

    await bootstrapConversationState(
      {
        getConversationState: async () => ({ ok: true, value: emptyState }),
        getConnections: connections("server"),
        initializeConversations,
      },
      { getItem, removeItem },
    );

    expect(initializeConversations).toHaveBeenCalledWith({ chats: {} });
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
