import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PLUGIN_CATALOG,
  type PluginRequest,
  type PluginSettingsView,
  type SavePluginSettingsRequest,
} from "../../shared/plugins";
import { PluginSettingsSection } from "./plugin-settings-section";
import type { BackendResult } from "../../shared/contracts";

function setup(configured = false, secureStorageAvailable = true) {
  let view: PluginSettingsView = {
    secureStorageAvailable,
    plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured, enabled: configured })),
  };
  const getPluginSettings = vi.fn(async () => ({ ok: true, value: view }));
  const savePluginSettings = vi.fn(
    async (request: SavePluginSettingsRequest): Promise<BackendResult<PluginSettingsView>> => {
      view = {
        ...view,
        plugins: view.plugins.map((plugin) =>
          plugin.id === request.pluginId ? { ...plugin, configured: true, enabled: request.enabled } : plugin,
        ),
      };
      return { ok: true, value: view };
    },
  );
  const testPluginConnection = vi.fn(async () => ({ ok: true, value: { message: "Connection successful." } }));
  const removePlugin = vi.fn(async ({ pluginId }: PluginRequest) => {
    view = {
      ...view,
      plugins: view.plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, configured: false, enabled: false } : plugin,
      ),
    };
    return { ok: true, value: view };
  });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getPluginSettings, savePluginSettings, testPluginConnection, removePlugin },
  });
  return { getPluginSettings, savePluginSettings, testPluginConnection, removePlugin };
}

describe("PluginSettingsSection", () => {
  it("reports unreadable credentials and still lets the user disable a plugin", async () => {
    const api = setup();
    const unreadable: PluginSettingsView = {
      secureStorageAvailable: true,
      credentialError: "Plugin credentials could not be read. Integration tools are unavailable.",
      plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: false, enabled: true })),
    };
    const disabled: PluginSettingsView = {
      ...unreadable,
      plugins: unreadable.plugins.map((plugin) => ({ ...plugin, enabled: plugin.id !== "linear" })),
    };
    api.getPluginSettings.mockResolvedValueOnce({ ok: true, value: unreadable });
    api.savePluginSettings.mockResolvedValueOnce({ ok: true, value: disabled });
    const user = userEvent.setup();
    const { unmount } = render(<PluginSettingsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Plugin credentials could not be read");
    const linear = within(screen.getByRole("region", { name: "Linear" }));
    await user.click(linear.getByRole("checkbox", { name: "Enable Linear" }));
    await user.click(linear.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({ pluginId: "linear", enabled: false });
    expect(await linear.findByText("Plugin settings saved.")).toBeVisible();
    expect(linear.getByRole("checkbox", { name: "Enable Linear" })).not.toBeChecked();
    unmount();
    api.getPluginSettings.mockResolvedValueOnce({ ok: true, value: disabled });
    render(<PluginSettingsSection />);
    expect(await screen.findByRole("checkbox", { name: "Enable Linear" })).not.toBeChecked();
  });
  it("tests an entered key, saves it, clears the password and uses the saved key for subsequent operations", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const web = within(await screen.findByRole("region", { name: "Web search" }));
    const key = web.getByLabelText("Brave Search API key");
    expect(key).toHaveAttribute("type", "password");
    expect(web.getByRole("button", { name: "Save plugin" })).toBeDisabled();
    await user.type(key, "brave-secret");
    await user.click(web.getByRole("button", { name: "Test connection" }));
    expect(api.testPluginConnection).toHaveBeenCalledWith({ pluginId: "web-search", apiKey: "brave-secret" });
    expect(api.savePluginSettings).not.toHaveBeenCalled();
    expect(key).toHaveValue("brave-secret");
    await user.click(web.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({
      pluginId: "web-search",
      enabled: true,
      apiKey: "brave-secret",
    });
    await waitFor(() => expect(key).toHaveValue(""));
    await user.click(web.getByRole("button", { name: "Test connection" }));
    expect(api.testPluginConnection).toHaveBeenLastCalledWith({ pluginId: "web-search" });
    await user.click(web.getByRole("checkbox", { name: "Enable Web search" }));
    await user.click(web.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenLastCalledWith({ pluginId: "web-search", enabled: false });
    expect(web.getByText("Connected · disabled")).toBeVisible();
    expect(screen.getByText(/Connecting a plugin does not give any Wisp access automatically/)).toBeVisible();
  });

  it("removes an existing connection without exposing its stored key", async () => {
    const api = setup(true);
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const linear = within(await screen.findByRole("region", { name: "Linear" }));
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("");
    await user.click(linear.getByRole("button", { name: "Remove connection" }));
    expect(api.removePlugin).toHaveBeenCalledWith({ pluginId: "linear" });
    expect(await linear.findByText("Not connected")).toBeVisible();
    expect(linear.getByRole("button", { name: "Save plugin" })).toBeDisabled();
  });

  it("preserves the entered key and reports a failed save without claiming success", async () => {
    const api = setup();
    api.savePluginSettings.mockResolvedValueOnce({
      ok: false,
      error: { message: "Secure storage is locked." },
    } as never);
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const linear = within(await screen.findByRole("region", { name: "Linear" }));
    await user.type(linear.getByLabelText("Linear personal API key"), "linear-secret");
    await user.click(linear.getByRole("button", { name: "Save plugin" }));
    expect(await linear.findByRole("alert")).toHaveTextContent("Secure storage is locked.");
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("linear-secret");
    expect(linear.getByText("Not connected")).toBeVisible();
    expect(linear.queryByText("Plugin settings saved.")).not.toBeInTheDocument();
  });

  it("prevents entering or saving a new key when secure storage is unavailable", async () => {
    setup(false, false);
    render(<PluginSettingsSection />);
    const web = within(await screen.findByRole("region", { name: "Web search" }));
    expect(web.getByLabelText("Brave Search API key")).toBeDisabled();
    expect(web.getByRole("button", { name: "Save plugin" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Secure credential storage is unavailable");
  });
});
