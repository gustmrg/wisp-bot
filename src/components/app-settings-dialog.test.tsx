import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppMetadata, CurrentUser } from "@/config/app-metadata";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import type { ConnectionsView } from "../../shared/connections";
import type { UpdateState } from "../../shared/contracts";
import { PLUGIN_CATALOG } from "../../shared/plugins";

const currentUser: CurrentUser = {
  displayName: "Ada Lovelace",
  givenName: "Ada",
  initials: "AL",
};

const memoryApi = {
  getMemory: vi.fn(async () => ({ ok: true as const, value: { entries: [], usage: [] } })),
  subscribeToAgentEvents: vi.fn(() => () => undefined),
};

const appMetadata: AppMetadata = {
  displayName: "Example Desktop",
  packageName: "example-desktop",
  version: "9.8.7",
};

function multiEnvView(overrides: Partial<ConnectionsView> = {}): ConnectionsView {
  const activeId = overrides.activeId ?? "local";
  return {
    activeId,
    profiles: [
      { id: "local", kind: "local", name: "This computer", paired: true },
      { id: "prod", kind: "url", name: "Prod server", url: "https://test-host.invalid", paired: true },
    ],
    status: { profileId: activeId, phase: activeId === "local" ? "local" : "connected", epoch: 1 },
    secureStorageAvailable: true,
    environments: {
      local: {
        profileId: "local",
        phase: "local",
        workingWisps: 0,
        pendingApprovals: 0,
        unreadConversations: 0,
        wispCount: 1,
        circleCount: 0,
      },
      prod: {
        profileId: "prod",
        phase: "connected",
        workingWisps: 0,
        pendingApprovals: 0,
        unreadConversations: 0,
        wispCount: 1,
        circleCount: 0,
      },
    },
    ...overrides,
  };
}

describe("AppSettingsDialog metadata", () => {
  it("opens plugins lazily and discards an unsaved key when leaving the section", async () => {
    const user = userEvent.setup();
    const getPluginSettings = vi.fn(async () => ({
      ok: true,
      value: {
        secureStorageAvailable: true,
        plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: false, enabled: false })),
        defaultProviders: { search: null, read: null },
      },
    }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({
          ok: true,
          value: { phase: "idle", currentVersion: appMetadata.version },
        })),
        getPluginSettings,
        getMcpSettings: vi.fn(async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } })),
        subscribeToMcpSettings: vi.fn(() => () => undefined),
        getWispPluginAccess: vi.fn(async ({ conversationId }: { conversationId: string }) => ({
          ok: true,
          value: { conversationId, grants: [], revision: "test-revision" },
        })),
        getWispMcpAccess: vi.fn(async ({ conversationId }: { conversationId: string }) => ({
          ok: true,
          value: { conversationId, grants: [], revision: "test-revision" },
        })),
      },
    });
    render(
      <AppSettingsDialog
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );
    expect(getPluginSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(await screen.findByRole("button", { name: "Connect Brave Search" }));
    const key = await screen.findByLabelText("Brave Search API key");
    await user.type(key, "unsaved-secret");
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(await screen.findByRole("button", { name: "Connect Brave Search" }));
    expect(await screen.findByLabelText("Brave Search API key")).toHaveValue("");
    expect(getPluginSettings).toHaveBeenCalledTimes(2);
  });

  it("opens MCP servers as its own panel and loads connections lazily", async () => {
    const user = userEvent.setup();
    const getMcpSettings = vi.fn(async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({
          ok: true,
          value: { phase: "idle", currentVersion: appMetadata.version },
        })),
        getPluginSettings: vi.fn(async () => ({
          ok: true,
          value: {
            secureStorageAvailable: true,
            plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: false, enabled: false })),
            defaultProviders: { search: null, read: null },
          },
        })),
        getMcpSettings,
        subscribeToMcpSettings: vi.fn(() => () => undefined),
      },
    });
    render(
      <AppSettingsDialog
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );
    expect(getMcpSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(await screen.findByText("No MCP servers connected yet.")).toBeInTheDocument();
    expect(getMcpSettings).toHaveBeenCalledTimes(1);
  });

  it("renders Profile & memory under Environment and keeps General device-local", async () => {
    const user = userEvent.setup();
    const getMemory = vi.fn(async () => ({ ok: true as const, value: { entries: [], usage: [] } }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        getMemory,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({
          ok: true,
          value: { phase: "idle", currentVersion: appMetadata.version },
        })),
      },
    });
    render(
      <AppSettingsDialog
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );

    // General no longer contains Name or About you.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(getMemory).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Launch at login" })).toBeDisabled();

    // Profile & memory lives under Environment.
    await user.click(screen.getByRole("button", { name: "Profile & memory" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(await screen.findByRole("region", { name: "About you" })).toBeVisible();
    expect(getMemory).toHaveBeenCalledWith({});

    expect(screen.getByRole("button", { name: "Notifications" })).toBeEnabled();
    expect(screen.queryByRole("switch", { name: "Notification sounds" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("switch", { name: "Notification sounds" })).toBeChecked();
    expect(screen.getByRole("slider", { name: "Volume" })).toHaveValue("100");
    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("button", { name: "Shortcuts" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Voice input" })).toBeEnabled();
    expect(screen.queryByText("ada@example.test")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About" }));

    expect(screen.getByText("Example Desktop")).toBeVisible();
    expect(screen.getByText("Version 9.8.7")).toBeVisible();
    expect(screen.getByRole("link", { name: /Release notes/ })).toHaveAttribute(
      "href",
      "https://github.com/gustmrg/wisp-bot/releases/tag/v9.8.7",
    );
    expect(screen.getByRole("link", { name: /Report an issue/ })).toHaveAttribute(
      "href",
      "https://github.com/gustmrg/wisp-bot/issues/new",
    );
  });

  it("gives every update phase its own button state", async () => {
    const user = userEvent.setup();
    let push: (state: UpdateState) => void = () => undefined;
    const checkForUpdates = vi.fn(async () => ({ ok: true, value: {} }));
    const downloadUpdate = vi.fn(async () => ({ ok: true, value: {} }));
    const installUpdate = vi.fn(async () => ({ ok: true, value: {} }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn((listener: (state: UpdateState) => void) => {
          push = listener;
          return () => undefined;
        }),
        getUpdateState: vi.fn(async () => ({ ok: true, value: { phase: "idle", currentVersion: "9.8.7" } })),
        checkForUpdates,
        downloadUpdate,
        installUpdate,
      },
    });
    render(
      <AppSettingsDialog
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "About" }));
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(checkForUpdates).toHaveBeenCalledOnce();

    act(() => push({ phase: "checking", currentVersion: "9.8.7" }));
    const checking = screen.getByRole("button", { name: "Checking for updates" });
    expect(checking).toBeDisabled();
    expect(checking.querySelector("svg")).toHaveClass("animate-spin");

    act(() => push({ phase: "available", currentVersion: "9.8.7", availableVersion: "9.9.0" }));
    expect(screen.getByText("Version 9.9.0 is available.")).toBeVisible();
    const download = screen.getByRole("button", { name: "Download update" });
    expect(download).toHaveClass("text-blue");
    expect(download.querySelector("svg")).not.toHaveClass("animate-spin");
    await user.click(download);
    expect(downloadUpdate).toHaveBeenCalledOnce();

    act(() => push({ phase: "downloading", currentVersion: "9.8.7", availableVersion: "9.9.0", progress: 40 }));
    const downloading = screen.getByRole("button", { name: "Downloading update" });
    expect(downloading).toBeDisabled();
    expect(downloading.querySelector("svg")).toHaveClass("animate-spin");
    expect(screen.getByText("Downloading update… 40%")).toBeVisible();

    act(() => push({ phase: "downloaded", currentVersion: "9.8.7", availableVersion: "9.9.0", progress: 100 }));
    const install = screen.getByRole("button", { name: "Restart and install update" });
    expect(install).toHaveClass("text-blue");
    await user.click(install);
    expect(installUpdate).toHaveBeenCalledOnce();

    act(() => push({ phase: "installing", currentVersion: "9.8.7", availableVersion: "9.9.0", progress: 100 }));
    const installing = screen.getByRole("button", { name: "Installing update" });
    expect(installing).toBeDisabled();
    expect(installing.querySelector("svg")).toHaveClass("animate-spin");
    expect(screen.getByText(/Installing version 9\.9\.0…/)).toBeVisible();
  });

  it("changes Wisp colors and reply speed from the application settings", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({
          ok: true,
          value: { phase: "idle", currentVersion: appMetadata.version },
        })),
      },
    });
    render(
      <AppSettingsDialog
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={onPreferencesChange}
      />,
    );

    const wispColors = screen.getByRole("switch", { name: "Wisp colors" });
    expect(wispColors).toBeChecked();
    await user.click(wispColors);
    expect(onPreferencesChange).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES, wispColors: false });

    await user.click(screen.getByRole("radio", { name: "Natural" }));
    expect(onPreferencesChange).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES, replyPace: "natural" });
    const circleTools = screen.getByRole("radiogroup", { name: "Tools in circles" });
    expect(within(circleTools).getByRole("radio", { name: "Show" })).toBeChecked();
    await user.click(within(circleTools).getByRole("radio", { name: "Hide" }));
    expect(onPreferencesChange).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES, circleToolCalls: "hide" });
  });
});

describe("AppSettingsDialog navigation", () => {
  it("groups sections cleanly into App and Environment without passive scope notes", () => {
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({ ok: true, value: { phase: "idle", currentVersion: "9.8.7" } })),
      },
    });
    render(
      <ActiveConnectionContext.Provider value={multiEnvView({ activeId: "prod" })}>
        <AppSettingsDialog
          appMetadata={appMetadata}
          currentUser={currentUser}
          userProfile={{ profile: { preferredName: "Ada" }, loading: false, error: null, save: vi.fn() }}
          open
          preferences={DEFAULT_PREFERENCES}
          persistenceStatus="saved"
          persistenceError={null}
          onOpenChange={vi.fn()}
          onPreferencesChange={vi.fn()}
        />
      </ActiveConnectionContext.Provider>,
    );

    const names = (group: string) =>
      within(screen.getByRole("group", { name: group }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
    expect(names("App")).toEqual(["General", "Notifications", "Shortcuts", "Connections", "Remote access", "About"]);
    expect(names("Environment")).toEqual([
      "Profile & memory",
      "AI Model",
      "Providers",
      "Voice input",
      "Plugins",
      "MCP servers",
      "Permissions",
      "Templates",
      "Jobs",
      "Storage",
      "Token usage",
    ]);
    // No passive scope badges appear on General even when connected to a remote server.
    expect(screen.queryByText("This device")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved on this device.")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();
  });
});

describe("AppSettingsDialog environment selector", () => {
  it("loads and edits another connected environment via invokeConnectionOperation without calling activateConnection", async () => {
    const user = userEvent.setup();
    const activateConnection = vi.fn();
    const onPreferencesChange = vi.fn();
    const invokeConnectionOperation = vi.fn(
      async ({ operation, payload }: { operation: string; payload?: unknown }) => {
        if (operation === "getUserProfile") return { ok: true, value: { preferredName: "Prod Ada" } };
        if (operation === "saveUserProfile") return { ok: true, value: payload };
        if (operation === "getMemory") return { ok: true, value: { entries: [], usage: [] } };
        if (operation === "getConversationState") {
          return {
            ok: true,
            value: {
              initialized: true,
              wisps: {
                "prod-wisp": {
                  id: "prod-wisp",
                  name: "Prod Bot",
                  role: "",
                  soul: "",
                  appearance: { base: "calm", eyes: "open", accessory: "none" },
                },
              },
              chats: {},
              liveMessages: {},
            },
          };
        }
        if (operation === "getToolPolicy") return { ok: true, value: { autoReview: false, rules: [] } };
        if (operation === "saveToolPolicy") return { ok: true, value: payload };
        return { ok: true, value: {} };
      },
    );

    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        activateConnection,
        invokeConnectionOperation,
        subscribeToConnectionEvents: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({ ok: true, value: { phase: "idle", currentVersion: "9.8.7" } })),
      },
    });

    const view = multiEnvView({ activeId: "local" });
    const props = {
      appMetadata,
      currentUser,
      userProfile: { profile: { preferredName: "Local Ada" }, loading: false, error: null, save: vi.fn() },
      open: true,
      initialSection: "profile" as const,
      preferences: DEFAULT_PREFERENCES,
      persistenceStatus: "saved" as const,
      persistenceError: null,
      onOpenChange: vi.fn(),
      onPreferencesChange,
    };

    const { rerender } = render(
      <ActiveConnectionContext.Provider value={view}>
        <AppSettingsDialog {...props} />
      </ActiveConnectionContext.Provider>,
    );

    // Starts on active environment (local) with zero cross-environment RPC calls.
    expect(screen.getByLabelText("Name")).toHaveValue("Local Ada");
    expect(invokeConnectionOperation).not.toHaveBeenCalled();

    // Switch Settings selector to Prod server.
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(await screen.findByRole("option", { name: /Prod server/ }));

    expect(await screen.findByLabelText("Name")).toHaveValue("Prod Ada");
    expect(activateConnection).not.toHaveBeenCalled();
    expect(invokeConnectionOperation).toHaveBeenCalledWith({ connectionId: "prod", operation: "getUserProfile" });

    // Edit profile name on Prod server -> routes through invokeConnectionOperation.
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Prod Grace");
    await user.tab();
    expect(invokeConnectionOperation).toHaveBeenCalledWith({
      connectionId: "prod",
      operation: "saveUserProfile",
      payload: { preferredName: "Prod Grace" },
    });

    // Navigating to Permissions keeps Prod server selected and edits its tool policy without touching local preferences.
    await user.click(screen.getByRole("button", { name: "Permissions" }));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("Prod server");
    const autoReviewSwitch = await screen.findByRole("switch", { name: "Auto-review file changes" });
    expect(autoReviewSwitch).not.toBeChecked();
    await user.click(autoReviewSwitch);
    expect(invokeConnectionOperation).toHaveBeenCalledWith({
      connectionId: "prod",
      operation: "saveToolPolicy",
      payload: { autoReview: true, rules: [] },
    });
    expect(onPreferencesChange).not.toHaveBeenCalled();

    // Closing and reopening resets selected environment back to activeId.
    rerender(
      <ActiveConnectionContext.Provider value={view}>
        <AppSettingsDialog {...props} open={false} />
      </ActiveConnectionContext.Provider>,
    );
    rerender(
      <ActiveConnectionContext.Provider value={view}>
        <AppSettingsDialog {...props} open />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("This computer");
    expect(screen.getByLabelText("Name")).toHaveValue("Local Ada");
  });

  it("shows an offline banner with Connect and Open Connections for disconnected or unpaired environments", async () => {
    const user = userEvent.setup();
    const connectEnvironment = vi.fn(async () => ({ ok: true, value: {} }));
    const getConnections = vi.fn(async () => ({ ok: true, value: view }));
    const invokeConnectionOperation = vi.fn();

    const view = multiEnvView({
      activeId: "local",
      profiles: [
        { id: "local", kind: "local", name: "This computer", paired: true },
        { id: "offline", kind: "url", name: "Offline box", url: "https://offline.invalid", paired: true },
        { id: "unpaired", kind: "url", name: "New server", url: "https://new.invalid", paired: false },
      ],
      environments: {
        local: {
          profileId: "local",
          phase: "local",
          workingWisps: 0,
          pendingApprovals: 0,
          unreadConversations: 0,
          wispCount: 1,
          circleCount: 0,
        },
        offline: {
          profileId: "offline",
          phase: "error",
          message: "Host unreachable.",
          workingWisps: 0,
          pendingApprovals: 0,
          unreadConversations: 0,
          wispCount: 0,
          circleCount: 0,
        },
        unpaired: {
          profileId: "unpaired",
          phase: "pairing_required",
          workingWisps: 0,
          pendingApprovals: 0,
          unreadConversations: 0,
          wispCount: 0,
          circleCount: 0,
        },
      },
    });

    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        connectEnvironment,
        getConnections,
        subscribeToConnections: vi.fn(() => () => undefined),
        invokeConnectionOperation,
        subscribeToConnectionEvents: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({ ok: true, value: { phase: "idle", currentVersion: "9.8.7" } })),
        getAiSettings: vi.fn(async () => ({
          ok: true,
          value: {
            selection: null,
            providers: [],
            fallback: { selection: null, unavailable: null },
            auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
            secureStorageAvailable: true,
          },
        })),
      },
    });

    render(
      <ActiveConnectionContext.Provider value={view}>
        <AppSettingsDialog
          appMetadata={appMetadata}
          currentUser={currentUser}
          userProfile={{ profile: { preferredName: "Ada" }, loading: false, error: null, save: vi.fn() }}
          open
          initialSection="model"
          preferences={DEFAULT_PREFERENCES}
          persistenceStatus="saved"
          persistenceError={null}
          onOpenChange={vi.fn()}
          onPreferencesChange={vi.fn()}
        />
      </ActiveConnectionContext.Provider>,
    );

    // Select offline paired server -> shows error message, Connect button, Open Connections button, and makes no RPC calls.
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(await screen.findByRole("option", { name: /Offline box/ }));

    expect(screen.getByText("Host unreachable.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(connectEnvironment).toHaveBeenCalledWith({ id: "offline" });
    expect(invokeConnectionOperation).not.toHaveBeenCalled();

    // Select unpaired server -> shows Not paired yet and Open Connections (no Connect button).
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(await screen.findByRole("option", { name: /New server/ }));
    expect(screen.getByText(/Pair New server in Connections/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();

    // Open Connections switches to the Connections panel.
    await user.click(screen.getByRole("button", { name: "Open Connections" }));
    expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
  });
});

describe("AppSettingsDialog on mobile", () => {
  it("shows the profile card and each section as a described card in App and Environment groups", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        ...memoryApi,
        subscribeToPluginSettings: vi.fn(() => () => undefined),
        subscribeToUpdateState: vi.fn(() => () => undefined),
        getUpdateState: vi.fn(async () => ({ ok: true, value: { phase: "idle", currentVersion: "9.8.7" } })),
      },
    });
    render(
      <AppSettingsDialog
        mobile
        appMetadata={appMetadata}
        currentUser={currentUser}
        userProfile={{
          profile: { preferredName: "Ada" },
          loading: false,
          error: null,
          save: vi.fn(),
        }}
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );

    const environment = screen.getByRole("group", { name: "Environment" });
    expect(
      within(environment)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Profile & memory",
      "AI Model",
      "Providers",
      "Voice input",
      "Plugins",
      "MCP servers",
      "Permissions",
      "Templates",
      "Jobs",
      "Storage",
      "Token usage",
    ]);
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAccessibleDescription(
      "See the space used and clean up Wisp files",
    );
    expect(screen.getByRole("group", { name: "App" })).toBeVisible();
    expect(screen.queryByText("Your workspace")).not.toBeInTheDocument();

    // Tapping the profile card opens Profile & memory.
    await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
  });

  it("chooses the conversation order with a description that stays the same", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    const props = {
      mobile: true,
      appMetadata,
      currentUser,
      userProfile: {
        profile: { preferredName: "Ada" },
        loading: false,
        error: null,
        save: vi.fn(),
      },
      open: true,
      persistenceStatus: "saved" as const,
      persistenceError: null,
      onOpenChange: vi.fn(),
      onPreferencesChange,
    };
    const { rerender } = render(<AppSettingsDialog {...props} preferences={DEFAULT_PREFERENCES} />);
    await user.click(screen.getByRole("button", { name: "General" }));
    const order = screen.getByRole("radiogroup", { name: "Conversation order" });
    const description = screen.getByText(/Pinned conversations always come first/);
    const text = description.textContent;

    await user.click(within(order).getByRole("radio", { name: "Creation" }));
    expect(onPreferencesChange).toHaveBeenCalledWith({ ...DEFAULT_PREFERENCES, chatListOrder: "created" });

    rerender(<AppSettingsDialog {...props} preferences={{ ...DEFAULT_PREFERENCES, chatListOrder: "created" }} />);
    expect(within(order).getByRole("radio", { name: "Creation" })).toBeChecked();
    expect(description).toBeInTheDocument();
    expect(description.textContent).toBe(text);
  });
});
