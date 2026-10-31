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
import type { McpServerSummary, McpSettingsView, SaveMcpServerRequest } from "../../shared/mcp";
import { PluginSettingsSection } from "./plugin-settings-section";
import type { BackendResult } from "../../shared/contracts";

const NO_PROVIDERS = { search: null, read: null };

function setup({
  configured = [] as ReadonlyArray<PluginId>,
  secureStorageAvailable = true,
  access = {} as Record<string, Partial<WispPluginAccessView>>,
  mcpServers = [] as McpServerSummary[],
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
  let mcpView: McpSettingsView = { secureStorageAvailable, servers: mcpServers };
  const getMcpSettings = vi.fn(async () => ({ ok: true, value: mcpView }));
  const saveMcpServer = vi.fn(async (request: SaveMcpServerRequest): Promise<BackendResult<McpSettingsView>> => {
    const saved: McpServerSummary = {
      serverId: request.serverId ?? "github-1",
      name: request.name,
      endpoint: request.endpoint,
      authMode: request.authMode,
      enabled: request.enabled ?? true,
      state: "connected",
      headerConfigured: true,
      ...(request.headerName ? { headerName: request.headerName } : {}),
      ...(request.extraHeaders ? { extraHeaders: request.extraHeaders } : {}),
      preset: request.preset ?? mcpView.servers.find(({ serverId }) => serverId === request.serverId)?.preset,
      lastDiscoveredAt: null,
      tools: [],
    };
    mcpView = {
      ...mcpView,
      servers: [...mcpView.servers.filter(({ serverId }) => serverId !== saved.serverId), saved],
    };
    return { ok: true, value: mcpView };
  });
  const testMcpConnection = vi.fn(async (_request: Record<string, unknown>) => ({
    ok: true,
    value: { message: "Connected. 3 tools available." },
  }));
  const getWispMcpAccess = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
    ok: true,
    value: { conversationId, revision: `${conversationId}-mcp`, grants: [] },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      subscribeToPluginSettings: vi.fn(() => () => undefined),
      getMcpSettings,
      saveMcpServer,
      testMcpConnection,
      getWispMcpAccess,
      subscribeToMcpSettings: vi.fn(() => () => undefined),
      removeMcpServer: vi.fn(),
      refreshMcpTools: vi.fn(),
      startMcpSignIn: vi.fn(async () => ({ ok: true, value: mcpView })),
      cancelMcpSignIn: vi.fn(),
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
    getMcpSettings,
    saveMcpServer,
    testMcpConnection,
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
    ["tavily", "Tavily", "Tavily"],
    ["exa", "Exa", "Exa"],
    // Named apart from DeepSeek's models; the key and the service are still DeepSeek's.
    ["deepseek", "DeepSeek Search", "DeepSeek"],
  ] as const)("connects %s by testing the key before saving it", async (pluginId, name, service) => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const form = await openPlugin(name);
    expect(form.getByRole("link", { name: `Get a ${service} API key` })).toHaveAttribute(
      "href",
      PLUGIN_CATALOG.find(({ id }) => id === pluginId)!.credentialUrl,
    );
    const key = form.getByLabelText(`${service} API key`);
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

  it("connects Home Assistant with the server address and the token together", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    const form = await openPlugin("Home Assistant");
    expect(form.getByRole("link", { name: "Create a long-lived access token" })).toBeVisible();
    await user.type(form.getByLabelText("Long-lived access token"), "ha-token");
    // The token alone is not enough.
    expect(form.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.type(form.getByLabelText("Home Assistant address"), "http://homeassistant.local:8123");
    await user.click(form.getByRole("button", { name: "Connect" }));
    const request = { pluginId: "home-assistant", apiKey: "ha-token", endpoint: "http://homeassistant.local:8123" };
    expect(api.testPluginConnection).toHaveBeenCalledWith(request);
    expect(api.savePluginSettings).toHaveBeenCalledWith({ ...request, enabled: true });
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

describe("PluginSettingsSection GitHub", () => {
  const githubServer: McpServerSummary = {
    serverId: "github-1",
    name: "GitHub",
    endpoint: "https://api.githubcopilot.com/mcp/",
    authMode: "header",
    enabled: true,
    state: "connected",
    headerConfigured: true,
    headerName: "Authorization",
    extraHeaders: { "X-MCP-Toolsets": "context,issues,actions" },
    preset: "github",
    lastDiscoveredAt: null,
    tools: [],
  };

  it("lists GitHub like any other plugin, without mentioning how it connects", async () => {
    const user = userEvent.setup();
    setup();
    render(<PluginSettingsSection />);
    const available = within(await screen.findByRole("region", { name: "Available" }));
    const github = await available.findByRole("button", { name: "Connect GitHub" });
    expect(github).toHaveTextContent("Development");
    expect(github).not.toHaveTextContent(/MCP|server/i);
    await user.click(github);
    const form = screen.getByRole("heading", { name: "Add GitHub" }).closest("div")!.parentElement!;
    expect(form).not.toHaveTextContent(/MCP|server|endpoint/i);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("adds GitHub with a token and the default toolsets, then asks for Wisp access", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection wisps={WISPS} />);

    await user.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a token/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/personal-access-tokens/new",
    );
    await user.type(screen.getByLabelText("Personal access token"), "github_pat_test");
    await user.click(screen.getByRole("checkbox", { name: /Actions/ }));
    await user.click(screen.getByRole("checkbox", { name: /Users/ }));
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toEqual({
      name: "GitHub",
      endpoint: "https://api.githubcopilot.com/mcp/",
      authMode: "header",
      headerName: "Authorization",
      headerValue: "Bearer github_pat_test",
      extraHeaders: { "X-MCP-Toolsets": "context,repos,issues,pull_requests,actions" },
      preset: "github",
      enabled: true,
    });
    expect(await screen.findByText("Connected to GitHub. Choose which Wisps can use it.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to plugins" }));
    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    expect(connected.getByRole("button", { name: "Manage GitHub" })).toHaveTextContent("0 Wisps with access");
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).not.toBeInTheDocument();
  });

  it("keeps a pasted Bearer prefix and tests without the preset", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await user.type(screen.getByLabelText("Personal access token"), "Bearer github_pat_test");
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(api.testMcpConnection).toHaveBeenCalledTimes(1));
    const payload = api.testMcpConnection.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("preset");
    expect(payload).toMatchObject({ headerValue: "Bearer github_pat_test" });
  });

  it("edits the saved toolsets without sending the token again", async () => {
    const api = setup({ mcpServers: [githubServer] });
    const user = userEvent.setup();
    render(<PluginSettingsSection initialPluginId="github" />);

    expect(await screen.findByRole("checkbox", { name: /Issues/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Repositories/ })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /Repositories/ }));
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    const payload = api.saveMcpServer.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({
      serverId: "github-1",
      extraHeaders: { "X-MCP-Toolsets": "context,repos,issues,actions" },
    });
    expect(payload).not.toHaveProperty("headerValue");
    expect(payload).not.toHaveProperty("preset");
  });

  it("turns GitHub off from its card, keeping the saved token and headers", async () => {
    const api = setup({ mcpServers: [githubServer] });
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    await user.click(await screen.findByRole("switch", { name: "Enable GitHub" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toEqual({
      serverId: "github-1",
      name: "GitHub",
      endpoint: "https://api.githubcopilot.com/mcp/",
      authMode: "header",
      headerName: "Authorization",
      enabled: false,
    });
    expect(await screen.findByRole("switch", { name: "Enable GitHub" })).not.toBeChecked();
  });
});

describe("PluginSettingsSection GitLab", () => {
  const gitlabServer: McpServerSummary = {
    serverId: "gitlab-1",
    name: "GitLab",
    endpoint: "https://example.com/gitlab/api/v4/mcp",
    authMode: "header",
    enabled: true,
    state: "connected",
    headerConfigured: true,
    headerName: "Authorization",
    extraHeaders: { "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,merge_requests" },
    preset: "gitlab",
    lastDiscoveredAt: null,
    tools: [],
  };

  it("adds GitLab.com by default, with the default toolsets", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Connect GitLab" }));
    expect(screen.getByLabelText("GitLab address")).toHaveValue("https://gitlab.com");
    expect(screen.getByRole("link", { name: /Create a token/ })).toHaveAttribute(
      "href",
      "https://gitlab.com/-/user_settings/personal_access_tokens",
    );
    await user.type(screen.getByLabelText("Personal access token"), "glpat-test");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toEqual({
      name: "GitLab",
      endpoint: "https://gitlab.com/api/v4/mcp",
      authMode: "header",
      headerName: "Authorization",
      headerValue: "Bearer glpat-test",
      extraHeaders: { "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,repository,merge_requests,work_items,ci" },
      preset: "gitlab",
      enabled: true,
    });
  });

  it("adds a self-managed instance and links to its token page", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Connect GitLab" }));
    const address = screen.getByLabelText("GitLab address");
    await user.clear(address);
    await user.type(address, "gitlab.example.com");
    expect(screen.getByRole("link", { name: /Create a token/ })).toHaveAttribute(
      "href",
      "https://gitlab.example.com/-/user_settings/personal_access_tokens",
    );
    await user.type(screen.getByLabelText("Personal access token"), "glpat-test");
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(api.testMcpConnection).toHaveBeenCalledTimes(1));
    expect(api.testMcpConnection.mock.calls[0]?.[0]).toMatchObject({
      endpoint: "https://gitlab.example.com/api/v4/mcp",
    });
  });

  it("cannot be saved without an address", async () => {
    setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Connect GitLab" }));
    await user.clear(screen.getByLabelText("GitLab address"));
    await user.type(screen.getByLabelText("Personal access token"), "glpat-test");
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
  });

  it("shows the saved instance and keeps it when only the toolsets change", async () => {
    const api = setup({ mcpServers: [gitlabServer] });
    const user = userEvent.setup();
    render(<PluginSettingsSection initialPluginId="gitlab" />);

    expect(await screen.findByLabelText("GitLab address")).toHaveValue("https://example.com/gitlab");
    await user.click(screen.getByRole("checkbox", { name: /CI\/CD/ }));
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toMatchObject({
      serverId: "gitlab-1",
      endpoint: "https://example.com/gitlab/api/v4/mcp",
      extraHeaders: { "X-Gitlab-Enabled-Mcp-Server-Toolsets": "core,merge_requests,ci" },
    });
  });
});

describe("PluginSettingsSection Atlassian", () => {
  it("connects Atlassian with a browser sign-in and nothing to fill in", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    const available = within(await screen.findByRole("region", { name: "Available" }));
    const atlassian = await available.findByRole("button", { name: "Connect Atlassian" });
    expect(atlassian).toHaveTextContent("Productivity");
    expect(atlassian).not.toHaveTextContent(/MCP|server/i);
    await user.click(atlassian);
    expect(screen.getByText(/You sign in to Atlassian in your browser/)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toEqual({
      name: "Atlassian",
      endpoint: "https://mcp.atlassian.com/v1/mcp",
      authMode: "oauth",
      preset: "atlassian",
      enabled: true,
    });
    await waitFor(() => expect(window.wisp.startMcpSignIn).toHaveBeenCalledTimes(1));
  });
});
