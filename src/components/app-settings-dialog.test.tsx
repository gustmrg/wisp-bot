import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppMetadata, CurrentUser } from "@/config/app-metadata";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import { PLUGIN_CATALOG } from "../../shared/plugins";

const currentUser: CurrentUser = {
  displayName: "Ada Lovelace",
  email: "ada@example.test",
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
    await user.click(screen.getByRole("button", { name: "Close" }));
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
        open
        preferences={DEFAULT_PREFERENCES}
        persistenceStatus="saved"
        persistenceError={null}
        onOpenChange={vi.fn()}
        onPreferencesChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("ada@example.test")).toBeVisible();
    expect(screen.getByText("AL")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "About" }));

    expect(screen.getByText("Example Desktop")).toBeVisible();
    expect(screen.getByText("Version 9.8.7")).toBeVisible();
  });
});
