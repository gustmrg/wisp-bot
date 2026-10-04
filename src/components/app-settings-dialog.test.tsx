import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppMetadata, CurrentUser } from "@/config/app-metadata";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import type { UpdateState } from "../../shared/contracts";
import { PLUGIN_CATALOG } from "../../shared/plugins";

const currentUser: CurrentUser = {
  displayName: "Ada Lovelace",
  givenName: "Ada",
  initials: "AL",
};

const appMetadata: AppMetadata = {
  displayName: "Example Desktop",
  packageName: "example-desktop",
  version: "9.8.7",
};

describe("AppSettingsDialog metadata", () => {
  it("opens plugins lazily and discards an unsaved key when leaving the section", async () => {
    const user = userEvent.setup();
    const getPluginSettings = vi.fn(async () => ({
      ok: true,
      value: {
        secureStorageAvailable: true,
        plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: false, enabled: false })),
      },
    }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
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
          profile: { preferredName: "Ada", aboutYou: "", responsePreferences: "" },
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
    await user.click(await screen.findByRole("button", { name: "Connect Web search" }));
    const key = await screen.findByLabelText("Brave Search API key");
    await user.type(key, "unsaved-secret");
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(await screen.findByRole("button", { name: "Connect Web search" }));
    expect(await screen.findByLabelText("Brave Search API key")).toHaveValue("");
    expect(getPluginSettings).toHaveBeenCalledTimes(2);
  });

  it("opens MCP servers as its own panel and loads connections lazily", async () => {
    const user = userEvent.setup();
    const getMcpSettings = vi.fn(async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }));
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
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
          profile: { preferredName: "Ada", aboutYou: "", responsePreferences: "" },
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

  it("renders injected user and application metadata", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
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
          profile: { preferredName: "Ada", aboutYou: "", responsePreferences: "" },
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

    expect(screen.getByLabelText("Preferred name")).toHaveValue("Ada");
    expect(screen.getByRole("button", { name: "Notifications (coming soon)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Shortcuts" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Voice input" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Launch at login" })).toBeDisabled();
    expect(screen.queryByText("ada@example.test")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About" }));

    expect(screen.getByText("Example Desktop")).toBeVisible();
    expect(screen.getByText("Version 9.8.7")).toBeVisible();
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
          profile: { preferredName: "Ada", aboutYou: "", responsePreferences: "" },
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
  });
});
