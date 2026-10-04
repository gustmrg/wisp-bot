import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AiSettingsView, WispApi } from "../shared/contracts";
import { chatSummary, type Chat, type ConversationStateView } from "../shared/conversations";
import App from "@/App";
import { LEGACY_STORAGE_KEY } from "@/hooks/use-conversations";
import { MOBILE_LAYOUT_QUERY } from "@/hooks/use-mobile-layout";

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

const UNCONFIGURED_AI: AiSettingsView = {
  selection: null,
  secureStorageAvailable: true,
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      credentialConfigured: false,
      models: [
        {
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text"],
          contextWindow: 10_000,
          maxOutputTokens: 1_000,
        },
      ],
    },
  ],
  catalogError: null,
};

const CONFIGURED_AI: AiSettingsView = {
  ...UNCONFIGURED_AI,
  selection: { providerId: "openrouter", modelId: "test-model" },
  providers: UNCONFIGURED_AI.providers.map((provider) => ({ ...provider, credentialConfigured: true })),
};

function conversationState(initialized: boolean, chats: Record<string, Chat> = {}): ConversationStateView {
  return {
    initialized,
    chats,
    statuses: Object.fromEntries(Object.keys(chats).map((id) => [id, "idle"])),
    liveMessages: {},
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  };
}

function createApi(initialState: ConversationStateView): WispApi {
  let state = initialState;
  const current = () => ({ ok: true as const, value: state });

  return {
    getPluginSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    savePluginSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    removePlugin: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    testPluginConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    getWispPluginAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision" },
    }),
    saveWispPluginAccess: async (request) => ({ ok: true, value: request }),
    getMcpSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    saveMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    removeMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    testMcpConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    refreshMcpTools: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    startMcpSignIn: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    cancelMcpSignIn: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    getWispMcpAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision" },
    }),
    saveWispMcpAccess: async (request) => ({ ok: true, value: request }),
    subscribeToMcpSettings: () => () => undefined,
    startConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    sendMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    abortConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    manageContext: async () => ({
      ok: false as const,
      error: { code: "configuration_required" as const, message: "Configure a model", retryable: false },
    }),
    getConversationModel: async () => ({
      ok: true as const,
      value: {
        override: null,
        effective: null,
        applied: null,
        pending: null,
        status: "configuration_required" as const,
      },
    }),
    applyModel: vi.fn(async () => ({ ok: true as const, value: {} })),
    disposeConversation: vi.fn(async () => ({ ok: true as const, value: {} })),
    subscribeToAgentEvents: vi.fn(() => () => undefined),
    getAiSettings: vi.fn(async () => ({ ok: true as const, value: CONFIGURED_AI })),
    saveAiSettings: vi.fn(async () => ({ ok: true as const, value: CONFIGURED_AI })),
    removeProviderCredential: vi.fn(async () => ({
      ok: true as const,
      value: { selection: null, secureStorageAvailable: true, providers: [], catalogError: null },
    })),
    getConversationState: vi.fn(async () => current()),
    initializeConversations: vi.fn(async ({ chats }) => {
      state = conversationState(true, chats);
      return current();
    }),
    createConversation: vi.fn(async ({ conversation: chat }) => {
      state = {
        ...state,
        chats: { ...state.chats, [chat.id]: chat },
        statuses: { ...state.statuses, [chat.id]: "idle" },
      };
      return current();
    }),
    updateConversation: vi.fn(async () => current()),
    deleteConversation: vi.fn(async () => current()),
    appendConversationMessage: vi.fn(async ({ conversationId, message }) => {
      const chat = state.chats[conversationId]!;
      const updated = { ...chat, messages: [...chat.messages, message] };
      state = { ...state, chats: { ...state.chats, [conversationId]: updated } };
      return { ok: true as const, value: { chat: chatSummary(updated), added: [message], updated: [] } };
    }),
    answerConversationPrompt: vi.fn(async ({ conversationId }) => ({
      ok: true as const,
      value: { chat: chatSummary(state.chats[conversationId]!), added: [], updated: [] },
    })),
    markConversationRead: vi.fn(async ({ conversationId }) => ({
      ok: true as const,
      value: { chat: chatSummary(state.chats[conversationId]!), added: [], updated: [] },
    })),
    subscribeToConversationChanges: vi.fn(() => () => undefined),
    getConversationMessages: vi.fn(async ({ conversationId }) => ({
      ok: true as const,
      value: { messages: state.chats[conversationId]?.messages ?? [], olderCursor: null, newerCursor: null },
    })),
    searchMessages: vi.fn(async () => ({ ok: true as const, value: [] })),
    getUsageReport: vi.fn(),
    getSessionReport: vi.fn(async () => ({ ok: true as const, value: null })),
    getToolPolicy: vi.fn(async () => ({ ok: true as const, value: { autoReview: true, rules: [] } })),
    getUserProfile: async () => ({
      ok: true as const,
      value: { preferredName: "Ada Lovelace", aboutYou: "", responsePreferences: "" },
    }),
    saveUserProfile: vi.fn(async (profile) => ({ ok: true as const, value: profile })),
    saveToolPolicy: vi.fn(async (settings) => ({ ok: true as const, value: settings })),
    resolveToolApproval: vi.fn(async () => ({ ok: true as const, value: {} })),
    getLaunchAtLoginState: async () => ({ ok: true, value: { supported: false, enabled: false } }),
    setLaunchAtLogin: async () => ({ ok: true, value: { supported: false, enabled: false } }),
    getUpdateState: vi.fn(async () => ({
      ok: true as const,
      value: { phase: "idle" as const, currentVersion: "0.1.0" },
    })),
    checkForUpdates: vi.fn(async () => ({
      ok: true as const,
      value: { phase: "up-to-date" as const, currentVersion: "0.1.0" },
    })),
    downloadUpdate: vi.fn(async () => ({
      ok: true as const,
      value: { phase: "downloaded" as const, currentVersion: "0.1.0" },
    })),
    installUpdate: vi.fn(async () => ({ ok: true as const, value: {} })),
    openReleasesPage: vi.fn(async () => ({ ok: true as const, value: {} })),
    subscribeToUpdateState: vi.fn(() => () => undefined),
    getWorkspace: vi.fn(async () => ({ ok: true as const, value: { usedBytes: 0, quotaBytes: 1024 } })),
    openWorkspaceFolder: vi.fn(async () => ({ ok: true as const, value: {} })),
    openSkillsFolder: vi.fn(async () => ({ ok: true as const, value: {} })),
    attachWorkspaceFiles: vi.fn(async () => ({
      ok: true as const,
      value: { files: [], workspace: { usedBytes: 0, quotaBytes: 1024 } },
    })),
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

  it("retains legacy conversations when backend initialization fails", async () => {
    const legacy = JSON.stringify({ chats: { atlas } });
    window.localStorage.setItem(LEGACY_STORAGE_KEY, legacy);
    const api = createApi(conversationState(false));
    vi.mocked(api.initializeConversations).mockResolvedValueOnce({
      ok: false,
      error: { code: "internal_error", message: "Could not save conversations.", retryable: true },
    });
    exposeApi(api);

    render(<App />);

    expect(await screen.findByText("Could not save conversations.")).toBeVisible();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(legacy);
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

  it("opens a message search result at that message", async () => {
    const user = userEvent.setup();
    const api = createApi(
      conversationState(true, {
        atlas: { ...atlas, messages: [{ id: "m1", type: "incoming", text: "The launch checklist is ready." }] },
      }),
    );
    vi.mocked(api.searchMessages).mockResolvedValue({
      ok: true,
      value: [{ conversationId: "atlas", messageId: "m1", snippet: "The launch checklist is ready." }],
    });
    exposeApi(api);
    render(<App />);
    // The transcript comes from a page, not from the conversation state.
    expect(await screen.findByText("The launch checklist is ready.")).toBeVisible();
    expect(api.getConversationMessages).toHaveBeenCalledWith({ conversationId: "atlas", page: "latest" });

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("textbox", { name: "Search" }), "launch");
    await user.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /launch checklist/ }));

    await waitFor(() =>
      expect(api.getConversationMessages).toHaveBeenLastCalledWith({
        conversationId: "atlas",
        page: "around",
        messageId: "m1",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("The launch checklist is ready.").closest("[data-message-id]")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
  });

  it("keeps desktop settings drafts when reselecting a conversation", async () => {
    const user = userEvent.setup();
    const beta: Chat = { ...atlas, id: "beta", name: "Beta" };
    exposeApi(createApi(conversationState(true, { atlas, beta })));
    render(<App />);
    await screen.findByRole("textbox", { name: "Message Atlas" });
    await user.click(screen.getByRole("button", { name: "Open Wisp settings" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Unsaved Atlas name");
    const list = screen.getByRole("navigation", { name: "Wisps and circles" });
    await user.click(within(list).getByRole("button", { name: /Atlas/ }));
    expect(name).toBeVisible();
    expect(name).toHaveValue("Unsaved Atlas name");
    await user.click(within(list).getByRole("button", { name: /Beta/ }));
    expect(screen.getByRole("complementary", { name: "Beta settings" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Beta");
  });

  it("points to the releases page when an update cannot auto-install", async () => {
    const user = userEvent.setup();
    const api = createApi(conversationState(true, { atlas }));
    vi.mocked(api.getUpdateState).mockResolvedValue({
      ok: true as const,
      value: {
        phase: "manual-download" as const,
        currentVersion: "0.1.0",
        availableVersion: "1.1.0",
        message: "This build cannot install updates automatically. Please update it manually.",
      },
    });
    exposeApi(api);
    render(<App />);
    await screen.findByRole("textbox", { name: "Message Atlas" });
    await user.click(screen.getByRole("button", { name: "Open user settings" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "About" }),
    );
    expect(screen.getByText(/can't install updates automatically/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open the releases page to download the update" }));
    expect(api.openReleasesPage).toHaveBeenCalledOnce();
  });
});

function setMobileViewport() {
  let mobile = true;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === MOBILE_LAYOUT_QUERY
      ? ({
          get matches() {
            return mobile;
          },
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
            listeners.add(listener as () => void),
          removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
            listeners.delete(listener as () => void),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: () => true,
        } as MediaQueryList)
      : original(query),
  );
  return (nextMobile: boolean) =>
    act(() => {
      mobile = nextMobile;
      for (const listener of listeners) listener();
    });
}

describe("Mobile workspace", () => {
  it("opens one screen at a time and keeps a draft across list, details and desktop resizing", async () => {
    const resize = setMobileViewport();
    const user = userEvent.setup();
    exposeApi(createApi(conversationState(true, { atlas })));
    render(<App />);
    const list = await screen.findByRole("navigation", {
      name: "Wisps and circles",
    });
    await waitFor(() => expect(within(list).getByRole("button", { name: /Atlas/ })).toBeVisible());
    expect(screen.queryByRole("textbox", { name: "Message Atlas" })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Atlas/ }));
    const composer = screen.getByRole("textbox", { name: "Message Atlas" });
    expect(composer).not.toHaveFocus();
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(screen.queryByRole("textbox", { name: "Message Atlas" })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Atlas/ }));
    expect(composer).toHaveValue("Keep this draft");
    await user.click(screen.getByRole("button", { name: "Open Wisp settings" }));
    expect(screen.getByRole("complementary", { name: "Atlas settings" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message Atlas" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(composer).toHaveValue("Keep this draft");
    resize(false);
    expect(list).toBeVisible();
    expect(composer).toBeVisible();
    expect(composer).toHaveValue("Keep this draft");
    resize(true);
    expect(list).not.toBeVisible();
    expect(composer).toBeVisible();
  });

  it("filters real statuses and unread flags, and opens search results as conversations", async () => {
    setMobileViewport();
    const user = userEvent.setup();
    const beta: Chat = { ...atlas, id: "beta", name: "Beta" };
    const state = conversationState(true, {
      atlas: { ...atlas, unread: true },
      beta,
    });
    state.statuses.beta = "working";
    exposeApi(createApi(state));
    render(<App />);
    await screen.findByRole("button", { name: "All 2" });
    await user.click(screen.getByRole("button", { name: "Unread 1" }));
    const list = screen.getByRole("navigation", { name: "Wisps and circles" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: /Atlas/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(within(list).getByRole("button", { name: /Beta/ })).toHaveTextContent("Working…");
    expect(within(list).queryByRole("button", { name: /Atlas/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Search conversations" }));
    await user.type(screen.getByRole("textbox", { name: "Search" }), "Atlas");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Atlas/ }));
    expect(screen.getByRole("textbox", { name: "Message Atlas" })).toBeVisible();
    expect(list).not.toBeVisible();
  });

  it("navigates settings sections and opens a newly created Wisp after the backend saves it", async () => {
    const resize = setMobileViewport();
    const user = userEvent.setup();
    const api = createApi(conversationState(true, { atlas }));
    exposeApi(api);
    render(<App />);
    await screen.findByRole("button", { name: "All 1" });
    await user.click(
      within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("button", { name: "Settings" }),
    );
    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to settings" }));
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Wisps" }));
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Travel Planner");
    resize(false);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Travel Planner");
    resize(true);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Travel Planner");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Create Wisp",
      }),
    );
    expect(await screen.findByRole("textbox", { name: "Message Travel Planner" })).toBeVisible();
    expect(api.createConversation).toHaveBeenCalledOnce();
  });
});

it.each([false, true])("preserves later navigation when deletion completes (mobile: %s)", async (mobile) => {
  setMobileViewport()(mobile);
  const user = userEvent.setup();
  const beta: Chat = { ...atlas, id: "beta", name: "Beta" };
  const api = createApi(conversationState(true, { atlas, beta }));
  let finishDelete = () => {};
  vi.mocked(api.deleteConversation).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishDelete = () => resolve({ ok: true, value: conversationState(true, { beta }) });
      }),
  );
  exposeApi(api);
  render(<App />);
  const list = await screen.findByRole("navigation", {
    name: "Wisps and circles",
  });
  await user.click(await within(list).findByRole("button", { name: /Atlas/ }));
  await user.click(screen.getByRole("button", { name: "Open Wisp settings" }));
  await user.click(screen.getByRole("button", { name: "Delete Wisp" }));
  await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
  await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledOnce());
  if (mobile) {
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    await user.click(screen.getByRole("button", { name: "Back to conversations" }));
  }
  await user.click(within(list).getByRole("button", { name: /Beta/ }));
  if (mobile) await user.click(screen.getByRole("button", { name: "Open Wisp settings" }));
  const name = screen.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Unsaved Beta name");
  await act(async () => finishDelete());
  expect(screen.getByRole("complementary", { name: "Beta settings" })).toBeVisible();
  expect(name).toHaveValue("Unsaved Beta name");
});

it("opens provider setup from an unconfigured Wisp and preserves its first draft", async () => {
  const user = userEvent.setup();
  const state = conversationState(true, { atlas });
  state.statuses.atlas = "configuration_required";
  const api = createApi(state);
  exposeApi(api);
  render(<App />);
  const composer = await screen.findByRole("textbox", { name: "Message Atlas" });
  await user.type(composer, "My first task{enter}");
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(api.appendConversationMessage).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Configure AI model" }));
  expect(await screen.findByRole("heading", { name: "AI Model" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(composer).toHaveValue("My first task");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});

describe("Onboarding", () => {
  it("asks for a name and a working model before opening the workspace", async () => {
    const user = userEvent.setup();
    const api = createApi(conversationState(false));
    api.getUserProfile = async () => ({
      ok: true,
      value: { preferredName: "", aboutYou: "", responsePreferences: "" },
    });
    vi.mocked(api.getAiSettings).mockResolvedValue({ ok: true, value: UNCONFIGURED_AI });
    exposeApi(api);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to Wisp" })).toBeVisible();
    expect(screen.getByText("Step 1 of 3")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create Wisp" })).not.toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "What should Wisps call you?" }), "Ada");
    await user.click(continueButton);
    expect(api.saveUserProfile).toHaveBeenCalledWith({ preferredName: "Ada", aboutYou: "", responsePreferences: "" });

    expect(await screen.findByRole("heading", { name: "Choose an AI model" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(await screen.findByLabelText("API key"), "test-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.saveAiSettings).toHaveBeenCalledWith({
      selection: { providerId: "openrouter", modelId: "test-model" },
      apiKey: "test-key",
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "You’re all set, Ada" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(await screen.findByText("Create a Wisp to get started.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open user settings" })).toHaveTextContent("Ada");
  });

  it("only asks for what is missing", async () => {
    const user = userEvent.setup();
    const api = createApi(conversationState(false));
    api.getUserProfile = async () => ({
      ok: true,
      value: { preferredName: "", aboutYou: "", responsePreferences: "" },
    });
    exposeApi(api);
    render(<App />);

    expect(await screen.findByText("Step 1 of 2")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "What should Wisps call you?" }), "Ada");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "You’re all set, Ada" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Choose an AI model" })).not.toBeInTheDocument();
  });

  it("asks for the model again when the default provider has no API key", async () => {
    const api = createApi(conversationState(false));
    vi.mocked(api.getAiSettings).mockResolvedValue({
      ok: true,
      value: { ...CONFIGURED_AI, providers: UNCONFIGURED_AI.providers },
    });
    exposeApi(api);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose an AI model" })).toBeVisible();
  });

  it("offers a retry when the model settings cannot be loaded", async () => {
    const user = userEvent.setup();
    const api = createApi(conversationState(false));
    vi.mocked(api.getAiSettings).mockResolvedValueOnce({
      ok: false,
      error: { code: "internal_error", message: "Settings are unreadable.", retryable: true },
    });
    exposeApi(api);
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unreadable.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Create a Wisp to get started.")).toBeVisible();
  });
});
