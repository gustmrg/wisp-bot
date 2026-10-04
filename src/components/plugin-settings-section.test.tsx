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

async function openPlugin(name: string) {
  const trigger = await screen.findByRole("button", { name: new RegExp(`^(Connect|Manage) ${name}$`) });
  await userEvent.click(trigger);
  return within(await screen.findByRole("region", { name }));
}

describe("PluginSettingsSection", () => {
  it("groups connections by category and saves a Firecrawl key", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const web = within(await screen.findByRole("region", { name: "Web & research" }));
    expect(web.getByRole("button", { name: "Connect Web search" })).toBeVisible();

    expect(
      within(screen.getByRole("region", { name: "Productivity" })).getByRole("button", { name: "Connect Linear" }),
    ).toBeVisible();
    const firecrawl = await openPlugin("Firecrawl");
    await user.type(firecrawl.getByLabelText("Firecrawl API key"), "fc-test-key");
    await user.click(firecrawl.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({
      pluginId: "firecrawl",
      enabled: true,
      apiKey: "fc-test-key",
    });
  });

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
    const linear = await openPlugin("Linear");
    await user.click(linear.getByRole("switch", { name: "Enable Linear" }));
    await user.click(linear.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({ pluginId: "linear", enabled: false });
    expect(await linear.findByText("Plugin settings saved.")).toBeVisible();
    expect(linear.getByRole("switch", { name: "Enable Linear" })).not.toBeChecked();
    unmount();
    api.getPluginSettings.mockResolvedValueOnce({ ok: true, value: disabled });
    render(<PluginSettingsSection />);
    const reopened = await openPlugin("Linear");
    expect(reopened.getByRole("switch", { name: "Enable Linear" })).not.toBeChecked();
  });
  it("tests an entered key, saves it, clears the password and uses the saved key for subsequent operations", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const web = await openPlugin("Web search");
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
    await user.click(web.getByRole("switch", { name: "Enable Web search" }));
    await user.click(web.getByRole("button", { name: "Save plugin" }));
    expect(api.savePluginSettings).toHaveBeenLastCalledWith({ pluginId: "web-search", enabled: false });
    expect(web.getByText("Connected · disabled")).toBeVisible();
    expect(screen.getByText(/Connecting a plugin does not give any Wisp access automatically/)).toBeVisible();
  });

  it("removes an existing connection without exposing its stored key", async () => {
    const api = setup(true);
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const linear = await openPlugin("Linear");
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("");
    await user.click(linear.getByRole("button", { name: "Remove connection" }));
    expect(api.removePlugin).not.toHaveBeenCalled();
    const confirm = within(linear.getByRole("group", { name: "Remove connection" }));
    await user.click(confirm.getByRole("button", { name: "Remove connection" }));
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
    const linear = await openPlugin("Linear");
    await user.type(linear.getByLabelText("Linear personal API key"), "linear-secret");
    await user.click(linear.getByRole("button", { name: "Save plugin" }));
    expect(await linear.findByRole("alert")).toHaveTextContent("Secure storage is locked.");
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("linear-secret");
    expect(linear.getByText("Not connected")).toBeVisible();
    expect(linear.queryByText("Plugin settings saved.")).not.toBeInTheDocument();
  });

  it("opens a plugin in place and returns to the list without stacking a dialog", async () => {
    setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    await openPlugin("Linear");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    expect(screen.queryByLabelText("Linear personal API key")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect Linear" })).toBeVisible();
  });

  it("prevents entering or saving a new key when secure storage is unavailable", async () => {
    setup(false, false);
    render(<PluginSettingsSection />);
    const web = await openPlugin("Web search");
    expect(web.getByLabelText("Brave Search API key")).toBeDisabled();
    expect(web.getByRole("button", { name: "Save plugin" })).toBeDisabled();
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("Secure credential storage is unavailable");
  });
});
