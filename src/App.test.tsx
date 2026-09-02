import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WispApi } from "../shared/contracts";
import type { Chat, ConversationStateView } from "../shared/conversations";
import App from "@/App";
import { LEGACY_STORAGE_KEY } from "@/hooks/use-conversations";

const atlas: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "Finds relevant information",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

function conversationState(initialized: boolean, chats: Record<string, Chat> = {}): ConversationStateView {
  return {
    initialized,
    chats,
    statuses: Object.fromEntries(Object.keys(chats).map((id) => [id, "idle"])),
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  };
}

function createApi(initialState: ConversationStateView): WispApi {
  let state = initialState;
  const current = () => ({ ok: true as const, value: state });

  return {
    startConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    sendMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    abortConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    applyModel: vi.fn(async () => ({ ok: true as const, value: {} })),
    disposeConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    subscribeToAgentEvents: vi.fn(() => () => undefined),
    getAiSettings: vi.fn(async () => ({
      ok: true as const,
      value: { selection: null, secureStorageAvailable: true, providers: [] },
    })),
    saveAiSettings: vi.fn(async () => ({
      ok: true as const,
      value: { selection: null, secureStorageAvailable: true, providers: [] },
    })),
    removeProviderCredential: vi.fn(async () => ({
      ok: true as const,
      value: { selection: null, secureStorageAvailable: true, providers: [] },
    })),
    getConversationState: vi.fn(async () => current()),
    initializeConversations: vi.fn(async ({ chats }) => {
      state = conversationState(true, chats);
      return current();
    }),
    createConversation: vi.fn(async () => current()),
    updateConversation: vi.fn(async () => current()),
    deleteConversation: vi.fn(async () => current()),
    appendConversationMessage: vi.fn(async ({ conversationId, message }) => {
      const chat = state.chats[conversationId];
      if (chat) {
        state = {
          ...state,
          chats: {
            ...state.chats,
            [conversationId]: { ...chat, messages: [...chat.messages, message] },
          },
        };
      }
      return current();
    }),
    answerConversationPrompt: vi.fn(async () => current()),
    markConversationRead: vi.fn(async () => current()),
    getToolPolicy: vi.fn(async () => ({ ok: true as const, value: { autoReview: true, rules: [] } })),
    saveToolPolicy: vi.fn(async (settings) => ({ ok: true as const, value: settings })),
    resolveToolApproval: vi.fn(async () => ({ ok: true as const, value: {} })),
  };
}

function exposeApi(api: WispApi): void {
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
}

describe("App", () => {
  it("renders the empty state after initializing an empty backend", async () => {
    const api = createApi(conversationState(false));
    exposeApi(api);

    render(<App />);

    expect(await screen.findByText("Create a Wisp to get started.")).toBeVisible();
    expect(api.initializeConversations).toHaveBeenCalledWith({ chats: {} });
  });

  it("ignores invalid legacy JSON during backend initialization", async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, "{invalid json");
    const api = createApi(conversationState(false));
    exposeApi(api);

    render(<App />);

    expect(await screen.findByText("Create a Wisp to get started.")).toBeVisible();
    expect(api.initializeConversations).toHaveBeenCalledWith({ chats: {} });
  });

  it("persists and forwards an outgoing message through the backend bridge", async () => {
    const user = userEvent.setup();
    const api = createApi(conversationState(true, { atlas }));
    exposeApi(api);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");

    render(<App />);

    const composer = await screen.findByRole("textbox", { name: "Message Atlas" });
    await user.type(composer, "Prepare the launch brief");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalledWith({
        conversationId: "atlas",
        requestId: "00000000-0000-4000-8000-000000000001",
        text: "Prepare the launch brief",
      });
    });
    expect(api.appendConversationMessage).toHaveBeenCalledWith({
      conversationId: "atlas",
      message: expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001",
        type: "outgoing",
        text: "Prepare the launch brief",
      }),
    });
  });
});
