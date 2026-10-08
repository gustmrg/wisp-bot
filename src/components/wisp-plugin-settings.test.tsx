import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BackendResult } from "../../shared/contracts";
import {
  PLUGIN_CATALOG,
  type PluginGrant,
  type PluginId,
  type SaveWispPluginAccessRequest,
  type WebProviders,
  type WispPluginAccessView,
} from "../../shared/plugins";
import type { McpGrant, McpServerSummary } from "../../shared/mcp";
import { WispPluginSettings } from "./wisp-plugin-settings";
import { WispDetails } from "./wisp-details";
import { wispChatView } from "@/test/chat-fixtures";

const NO_PROVIDERS: WebProviders = { search: null, read: null };

function setup({
  available = PLUGIN_CATALOG.map(({ id }) => id),
  disabled = [],
  grants = [],
  webProviders = NO_PROVIDERS,
  defaultProviders = { search: "web-search", read: "firecrawl" },
  mcpServers = [],
  mcpGrants = [],
}: {
  available?: ReadonlyArray<PluginId>;
  disabled?: ReadonlyArray<PluginId>;
  grants?: ReadonlyArray<PluginGrant>;
  webProviders?: WebProviders;
  defaultProviders?: WebProviders;
  mcpServers?: ReadonlyArray<McpServerSummary>;
  mcpGrants?: ReadonlyArray<McpGrant>;
} = {}) {
  const getPluginSettings = vi.fn(async () => ({
    ok: true,
    value: {
      secureStorageAvailable: true,
      plugins: PLUGIN_CATALOG.map((plugin) => ({
        ...plugin,
        configured: available.includes(plugin.id) || disabled.includes(plugin.id),
        enabled: available.includes(plugin.id),
      })),
      defaultProviders,
    },
  }));
  const getWispPluginAccess = vi.fn(
    async ({ conversationId }: { conversationId: string }): Promise<BackendResult<WispPluginAccessView>> => ({
      ok: true,
      value: { conversationId, grants, webProviders, revision: "original-revision" },
    }),
  );
  const saveWispPluginAccess = vi.fn(
    async (request: SaveWispPluginAccessRequest): Promise<BackendResult<WispPluginAccessView>> => ({
      ok: true,
      value: { ...request, webProviders: request.webProviders ?? NO_PROVIDERS },
    }),
  );
  const getMcpSettings = vi.fn(async () => ({
    ok: true,
    value: { secureStorageAvailable: true, servers: mcpServers },
  }));
  const getWispMcpAccess = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
    ok: true,
    value: { conversationId, grants: mcpGrants, revision: "mcp-original-revision" },
  }));
  const saveWispMcpAccess = vi.fn(
    async (request: { conversationId: string; grants: ReadonlyArray<unknown>; revision: string }) => ({
      ok: true,
      value: request,
    }),
  );
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getPluginSettings,
      getWispPluginAccess,
      saveWispPluginAccess,
      getMcpSettings,
      getWispMcpAccess,
      saveWispMcpAccess,
    },
  });
  return { getPluginSettings, getWispPluginAccess, saveWispPluginAccess, saveWispMcpAccess };
}

function grantsFor(access: Partial<Record<PluginId, PluginGrant["access"]>>): PluginGrant[] {
  return PLUGIN_CATALOG.map(({ id }) => ({ pluginId: id, access: access[id] ?? "none" }));
}

async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
}

describe("WispPluginSettings", () => {
  it("picks one provider per web capability and grants only the providers in use", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    const search = await screen.findByRole("combobox", { name: "Search the web access" });
    expect(search).toHaveTextContent("No access");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    await openSelect(user, search);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "No access",
      "Brave Search (default)",
      "Firecrawl",
      "Tavily",
      "Exa",
    ]);
    await user.click(screen.getByRole("option", { name: "Tavily" }));
    await openSelect(user, screen.getByRole("combobox", { name: "Read web pages access" }));
    expect(screen.queryByRole("option", { name: /Brave Search/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Exa" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "original-revision",
      grants: grantsFor({ tavily: "read", exa: "read" }),
      webProviders: { search: "tavily", read: "exa" },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Access settings saved for this Wisp.");
  });

  it("lists always-allowed MCP tools and saves their removal", async () => {
    const server: McpServerSummary = {
      serverId: "docs",
      name: "Docs",
      endpoint: "https://docs.example.com/mcp",
      authMode: "none",
      enabled: true,
      state: "connected",
      headerConfigured: false,
      lastDiscoveredAt: "2026-10-08T12:00:00.000Z",
      tools: [
        { name: "search", alias: "mcp_docs_search", label: "search", description: "", fingerprint: "a" },
        { name: "fetch", alias: "mcp_docs_fetch", label: "fetch", description: "", fingerprint: "b" },
      ],
    };
    const api = setup({
      mcpServers: [server],
      mcpGrants: [{ serverId: "docs", access: "use_with_approval", alwaysAllowedTools: ["fetch", "search"] }],
    });
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    await user.click(await screen.findByRole("button", { name: "Ask again before search" }));
    expect(screen.queryByRole("button", { name: "Ask again before search" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispMcpAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "mcp-original-revision",
      grants: [{ serverId: "docs", access: "use_with_approval", alwaysAllowedTools: ["fetch"] }],
    });
  });

  it("saves read and write access for apps alongside web choices", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    await openSelect(user, await screen.findByRole("combobox", { name: "Linear access" }));
    await user.click(screen.getByRole("option", { name: "Read and write" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "original-revision",
      grants: grantsFor({ linear: "write" }),
      webProviders: NO_PROVIDERS,
    });
  });

  it("summarizes unavailable plugins in one line and links to Settings", async () => {
    setup({ available: ["web-search"], disabled: ["linear"], defaultProviders: { search: "web-search", read: null } });
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByRole("combobox", { name: "Search the web access" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Linear access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Read web pages access" })).not.toBeInTheDocument();
    expect(screen.getByText(/Read web pages: no connected plugin provides this/)).toBeVisible();
    expect(screen.getByText(/Unavailable: Linear \(turned off\), Firecrawl, Tavily, Exa/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set up plugins" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith({ section: "plugins" });
    await user.click(screen.getByRole("button", { name: "Add an MCP server" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith({ section: "mcp" });
  });

  it("keeps unavailable grants visible so they can be revoked", async () => {
    const api = setup({
      available: [],
      grants: grantsFor({ linear: "write", "web-search": "read" }),
      webProviders: { search: "web-search", read: null },
      defaultProviders: NO_PROVIDERS,
    });
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" onOpenSettings={onOpenSettings} />);
    await openSelect(user, await screen.findByRole("combobox", { name: "Linear access" }));
    expect(screen.getByRole("option", { name: "Read only" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Read and write" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "No access" }));
    await openSelect(user, screen.getByRole("combobox", { name: "Search the web access" }));
    expect(screen.getByRole("option", { name: "Brave Search" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "No access" }));
    await user.click(screen.getByRole("button", { name: "Connect Linear" }));
    expect(onOpenSettings).toHaveBeenCalledWith({ section: "plugins", pluginId: "linear" });
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "original-revision",
      grants: grantsFor({}),
      webProviders: NO_PROVIDERS,
    });
  });

  it("retains the draft and displays backend failures", async () => {
    const api = setup();
    api.saveWispPluginAccess.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "invalid_configuration",
        message: "Linear was disconnected. Reload access settings.",
        retryable: true,
      },
    });
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    await openSelect(user, await screen.findByRole("combobox", { name: "Linear access" }));
    await user.click(screen.getByRole("option", { name: "Read only" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Linear was disconnected");
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("Read only");
    expect(screen.getByRole("button", { name: "Save access" })).toBeEnabled();
  });

  it("does not apply a previous Wisp's delayed response when the selected Wisp changes", async () => {
    const api = setup();
    let resolveFirst!: (result: BackendResult<WispPluginAccessView>) => void;
    api.getWispPluginAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { rerender } = render(<WispPluginSettings conversationId="first" />);
    await waitFor(() => expect(api.getWispPluginAccess).toHaveBeenCalledWith({ conversationId: "first" }));
    rerender(<WispPluginSettings conversationId="second" />);
    expect(await screen.findByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    await act(async () => {
      resolveFirst({
        ok: true,
        value: {
          conversationId: "first",
          revision: "first-revision",
          grants: [{ pluginId: "linear", access: "write" }],
          webProviders: NO_PROVIDERS,
        },
      });
    });
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    const user = userEvent.setup();
    await openSelect(user, screen.getByRole("combobox", { name: "Search the web access" }));
    await user.click(screen.getByRole("option", { name: /Brave Search/ }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "second" }));
  });

  it("reloads a rejected stale form without replaying its previous choices", async () => {
    const api = setup();
    const user = userEvent.setup();
    api.saveWispPluginAccess.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "invalid_request",
        message: "Plugin settings changed. Reload access settings before saving.",
        retryable: false,
      },
    });
    render(<WispPluginSettings conversationId="researcher" />);
    await openSelect(user, await screen.findByRole("combobox", { name: "Linear access" }));
    await user.click(screen.getByRole("option", { name: "Read and write" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plugin settings changed");
    expect(api.saveWispPluginAccess).toHaveBeenCalledTimes(1);
    api.getWispPluginAccess.mockResolvedValueOnce({
      ok: true,
      value: { conversationId: "researcher", grants: [], webProviders: NO_PROVIDERS, revision: "replacement-revision" },
    });
    await user.click(screen.getByRole("button", { name: "Reload access settings" }));
    const search = await screen.findByRole("combobox", { name: "Search the web access" });
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    await openSelect(user, search);
    await user.click(screen.getByRole("option", { name: /Brave Search/ }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenLastCalledWith({
      conversationId: "researcher",
      revision: "replacement-revision",
      grants: grantsFor({ "web-search": "read" }),
      webProviders: { search: "web-search", read: null },
    });
  });

  it("reloads global connections every time the Access tab opens", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(
      <WispDetails
        chat={wispChatView("researcher", { wisp: { name: "Researcher", role: "Research", soul: "" } })}
        onChangeWisp={vi.fn()}
        onChangeNotifications={vi.fn()}
      />,
    );
    expect(api.getPluginSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Access" }));
    expect(await screen.findByRole("combobox", { name: "Linear access" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "General" }));
    await user.click(screen.getByRole("tab", { name: "Access" }));
    await waitFor(() => expect(api.getPluginSettings).toHaveBeenCalledTimes(2));
    expect(api.getWispPluginAccess).toHaveBeenCalledTimes(2);
  });
});
