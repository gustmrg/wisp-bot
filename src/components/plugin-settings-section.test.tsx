import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PLUGIN_CATALOG,
  type PluginId,
  type PluginRequest,
  type PluginSettingsView,
  type SavePluginDefaultsRequest,
  type SavePluginSettingsRequest,
  type SaveWispPluginAccessRequest,
  type WispPluginAccessView,
} from "../../shared/plugins";
import { PluginSettingsSection } from "./plugin-settings-section";
import type { BackendResult } from "../../shared/contracts";

const NO_PROVIDERS = { search: null, read: null };

function setup({
  configured = [] as ReadonlyArray<PluginId>,
  secureStorageAvailable = true,
  access = {} as Record<string, Partial<WispPluginAccessView>>,
} = {}) {
  let view: PluginSettingsView = {
    secureStorageAvailable,
    plugins: PLUGIN_CATALOG.map((plugin) => ({
      ...plugin,
      configured: configured.includes(plugin.id),
      enabled: configured.includes(plugin.id),
    })),
    defaultProviders: NO_PROVIDERS,
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
  const savePluginDefaults = vi.fn(async ({ defaultProviders }: SavePluginDefaultsRequest) => {
    view = { ...view, defaultProviders };
    return { ok: true, value: view };
  });
  const testPluginConnection = vi.fn(
    async (): Promise<BackendResult<{ message: string }>> => ({
      ok: true,
      value: { message: "Connection successful." },
    }),
  );
  const removePlugin = vi.fn(async ({ pluginId }: PluginRequest) => {
    view = {
      ...view,
      plugins: view.plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, configured: false, enabled: false } : plugin,
      ),
    };
    return { ok: true, value: view };
  });
  const getWispPluginAccess = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
    ok: true,
    value: {
      conversationId,
      revision: `${conversationId}-revision`,
      grants: [],
      webProviders: NO_PROVIDERS,
      ...access[conversationId],
    },
  }));
  const saveWispPluginAccess = vi.fn(async (request: SaveWispPluginAccessRequest) => ({
    ok: true,
    value: { ...request, webProviders: request.webProviders ?? NO_PROVIDERS },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getPluginSettings,
      savePluginSettings,
      savePluginDefaults,
      testPluginConnection,
      removePlugin,
      getWispPluginAccess,
      saveWispPluginAccess,
    },
  });
  return {
    getPluginSettings,
    savePluginSettings,
    savePluginDefaults,
    testPluginConnection,
    removePlugin,
    getWispPluginAccess,
    saveWispPluginAccess,
  };
}

async function openPlugin(name: string) {
  const trigger = await screen.findByRole("button", { name: new RegExp(`^(Connect|Manage) ${name}$`) });
  await userEvent.click(trigger);
  return within(await screen.findByRole("region", { name }));
}

async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
}

const WISPS = [
  { id: "researcher", name: "Researcher" },
  { id: "writer", name: "Writer" },
];

describe("PluginSettingsSection", () => {
  it("separates connected plugins from available ones and shows what each provides", async () => {
    setup({ configured: ["linear"] });
    const openMcp = vi.fn();
    const user = userEvent.setup();
    render(<PluginSettingsSection onOpenMcpSettings={openMcp} />);
    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    expect(connected.getByRole("button", { name: "Manage Linear" })).toBeVisible();
    expect(connected.getByRole("switch", { name: "Enable Linear" })).toBeChecked();
    const available = within(screen.getByRole("region", { name: "Available" }));
    const brave = available.getByRole("button", { name: "Connect Brave Search" });
    expect(brave).toHaveTextContent("Search");
    expect(brave).not.toHaveTextContent("Page reading");
    expect(available.getByRole("button", { name: "Connect Tavily" })).toHaveTextContent("Page reading");
    expect(screen.queryByRole("button", { name: /Web search/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add an MCP server" }));
    expect(openMcp).toHaveBeenCalled();
  });

  it.each([
    ["tavily", "Tavily"],
    ["exa", "Exa"],
  ] as const)("connects %s by testing the key before saving it", async (pluginId, name) => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const form = await openPlugin(name);
    expect(form.getByRole("link", { name: `Get a ${name} API key` })).toHaveAttribute(
      "href",
      PLUGIN_CATALOG.find(({ id }) => id === pluginId)!.credentialUrl,
    );
    const key = form.getByLabelText(`${name} API key`);
    expect(key).toHaveAttribute("type", "password");
    expect(form.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.type(key, `${pluginId}-test-key`);
    await user.click(form.getByRole("button", { name: "Connect" }));
    expect(api.testPluginConnection).toHaveBeenCalledWith({ pluginId, apiKey: `${pluginId}-test-key` });
    expect(api.savePluginSettings).toHaveBeenCalledWith({ pluginId, enabled: true, apiKey: `${pluginId}-test-key` });
    const manage = within(await screen.findByRole("region", { name }));
    expect(manage.getByText("Connected · enabled")).toBeVisible();
    expect(manage.getByRole("status")).toHaveTextContent(`Connected to ${name}.`);
  });

  it("does not save a key that fails the connection test", async () => {
    const api = setup();
    api.testPluginConnection.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid_request", message: "Linear rejected the key.", retryable: false },
    });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const linear = await openPlugin("Linear");
    await user.type(linear.getByLabelText("Linear personal API key"), "linear-secret");
    await user.click(linear.getByRole("button", { name: "Connect" }));
    expect(await linear.findByRole("alert")).toHaveTextContent("Linear rejected the key.");
    expect(api.savePluginSettings).not.toHaveBeenCalled();
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("linear-secret");
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
    await user.click(linear.getByRole("button", { name: "Connect" }));
    expect(await linear.findByRole("alert")).toHaveTextContent("Secure storage is locked.");
    expect(linear.getByLabelText("Linear personal API key")).toHaveValue("linear-secret");
    expect(screen.queryByText("Connected · enabled")).not.toBeInTheDocument();
  });

  it("turns a connected plugin off from its card without opening it", async () => {
    const api = setup({ configured: ["web-search"] });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    await user.click(await screen.findByRole("switch", { name: "Enable Brave Search" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({ pluginId: "web-search", enabled: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Brave Search" })).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Manage Brave Search" })).toHaveTextContent("Disabled");
  });

  it("tests the saved key, warns before replacing it and removes the connection", async () => {
    const api = setup({ configured: ["linear"] });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const linear = await openPlugin("Linear");
    await user.click(linear.getByRole("button", { name: "Test connection" }));
    expect(api.testPluginConnection).toHaveBeenLastCalledWith({ pluginId: "linear" });
    expect(await linear.findByText("Connection successful.")).toBeVisible();

    await user.click(linear.getByRole("button", { name: "Replace key" }));
    const key = linear.getByLabelText("New Linear personal API key");
    expect(key).toHaveValue("");
    expect(linear.queryByText(/removes Linear from every Wisp/)).not.toBeInTheDocument();
    await user.type(key, "other-account");
    expect(linear.getByText(/removes Linear from every Wisp/)).toBeVisible();
    await user.click(linear.getByRole("button", { name: "Test and replace key" }));
    expect(api.testPluginConnection).toHaveBeenLastCalledWith({ pluginId: "linear", apiKey: "other-account" });
    expect(api.savePluginSettings).toHaveBeenLastCalledWith({
      pluginId: "linear",
      enabled: true,
      apiKey: "other-account",
    });
    expect(await linear.findByText(/Key replaced/)).toBeVisible();

    await user.click(linear.getByRole("button", { name: "Remove connection" }));
    expect(api.removePlugin).not.toHaveBeenCalled();
    const confirm = within(linear.getByRole("group", { name: "Remove connection" }));
    await user.click(confirm.getByRole("button", { name: "Remove connection" }));
    expect(api.removePlugin).toHaveBeenCalledWith({ pluginId: "linear" });
    const reconnect = within(await screen.findByRole("region", { name: "Linear" }));
    expect(await reconnect.findByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("reports unreadable credentials and still lets the user disable a plugin", async () => {
    const api = setup();
    const unreadable: PluginSettingsView = {
      secureStorageAvailable: true,
      credentialError: "Plugin credentials could not be read. Integration tools are unavailable.",
      plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: false, enabled: true })),
      defaultProviders: NO_PROVIDERS,
    };
    const disabled: PluginSettingsView = {
      ...unreadable,
      plugins: unreadable.plugins.map((plugin) => ({ ...plugin, enabled: plugin.id !== "linear" })),
    };
    api.getPluginSettings.mockResolvedValueOnce({ ok: true, value: unreadable });
    api.savePluginSettings.mockResolvedValueOnce({ ok: true, value: disabled });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Plugin credentials could not be read");
    const linear = await openPlugin("Linear");
    await user.click(linear.getByRole("switch", { name: "Enable Linear" }));
    expect(api.savePluginSettings).toHaveBeenCalledWith({ pluginId: "linear", enabled: false });
    await waitFor(() => expect(linear.getByRole("switch", { name: "Enable Linear" })).not.toBeChecked());
  });

  it("opens a plugin in place, returns to the list and can start at a requested plugin", async () => {
    setup();
    const user = userEvent.setup();
    const { unmount } = render(<PluginSettingsSection />);
    await openPlugin("Linear");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    expect(screen.queryByLabelText("Linear personal API key")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect Linear" })).toBeVisible();
    unmount();
    render(<PluginSettingsSection initialPluginId="exa" />);
    expect(await screen.findByLabelText("Exa API key")).toBeVisible();
  });

  it("prevents entering or saving a new key when secure storage is unavailable", async () => {
    setup({ secureStorageAvailable: false });
    render(<PluginSettingsSection />);
    const brave = await openPlugin("Brave Search");
    expect(brave.getByLabelText("Brave Search API key")).toBeDisabled();
    expect(brave.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("Secure credential storage is unavailable");
  });

  it("chooses a default provider only for capabilities with several connected providers", async () => {
    const api = setup({ configured: ["web-search", "tavily"] });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const search = await screen.findByRole("combobox", { name: "Default for Search the web" });
    expect(screen.queryByRole("combobox", { name: "Default for Read web pages" })).not.toBeInTheDocument();
    await openSelect(user, search);
    await user.click(screen.getByRole("option", { name: "Tavily" }));
    expect(api.savePluginDefaults).toHaveBeenCalledWith({ defaultProviders: { search: "tavily", read: null } });
  });

  it("gives Wisps access from the plugin, replacing their current provider, and counts them", async () => {
    const api = setup({
      configured: ["web-search", "tavily"],
      access: {
        researcher: {
          grants: [{ pluginId: "web-search", access: "read" }],
          webProviders: { search: "web-search", read: null },
        },
      },
    });
    const user = userEvent.setup();
    render(<PluginSettingsSection wisps={WISPS} />);
    expect(await screen.findByRole("button", { name: "Manage Brave Search" })).toHaveTextContent("1 Wisp with access");
    expect(screen.getByRole("button", { name: "Manage Tavily" })).toHaveTextContent("0 Wisps with access");
    const tavily = await openPlugin("Tavily");
    const researcher = await tavily.findByRole("combobox", { name: "Researcher access" });
    expect(researcher).toHaveTextContent("No access");
    expect(tavily.getByRole("button", { name: "Save Wisp access" })).toBeDisabled();
    await openSelect(user, researcher);
    await user.click(screen.getByRole("option", { name: "Search and reading" }));
    expect(tavily.getByText("Replaces Brave Search for search.")).toBeVisible();
    await user.click(tavily.getByRole("button", { name: "Save Wisp access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledTimes(1);
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "researcher-revision",
      grants: PLUGIN_CATALOG.map(({ id }) => ({ pluginId: id, access: id === "tavily" ? "read" : "none" })),
      webProviders: { search: "tavily", read: "tavily" },
    });
    expect(await tavily.findByText("Wisp access saved.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    expect(await screen.findByRole("button", { name: "Manage Tavily" })).toHaveTextContent("1 Wisp with access");
    expect(screen.getByRole("button", { name: "Manage Brave Search" })).toHaveTextContent("0 Wisps with access");
  });
});
