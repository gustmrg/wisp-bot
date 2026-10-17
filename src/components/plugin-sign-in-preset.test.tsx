import { StrictMode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BackendResult } from "../../shared/contracts";
import type { McpServerSummary, McpSettingsView, SaveMcpServerRequest } from "../../shared/mcp";
import type { McpPreset } from "../../shared/mcp-presets";
import { PluginSettingsSection } from "./plugin-settings-section";

// A plugin that signs in through the browser, standing in for the real ones.
vi.mock("../../shared/mcp-presets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shared/mcp-presets")>();
  const docs: McpPreset = {
    id: "docs" as never,
    name: "Docs",
    endpoint: "https://mcp.docs.example.com/mcp",
    description: "Search and read your team's docs.",
    category: "Productivity",
    auth: { mode: "oauth", help: "You approve access in your browser." },
  };
  return {
    ...original,
    MCP_PRESET_IDS: ["docs"],
    MCP_PRESETS: { docs },
    isMcpPresetId: (value: unknown) => value === "docs",
  };
});

const WISPS = [{ id: "researcher", name: "Researcher" }];

function docsServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    serverId: "docs-1",
    name: "Docs",
    endpoint: "https://mcp.docs.example.com/mcp",
    authMode: "oauth",
    enabled: true,
    state: "needs_sign_in",
    headerConfigured: false,
    preset: "docs" as never,
    lastDiscoveredAt: null,
    tools: [],
    ...overrides,
  };
}

function setup(servers: McpServerSummary[] = []) {
  let view: McpSettingsView = { secureStorageAvailable: true, servers };
  let settleSignIn: ((result: BackendResult<McpSettingsView>) => void) | undefined;
  const saveMcpServer = vi.fn(async (request: SaveMcpServerRequest): Promise<BackendResult<McpSettingsView>> => {
    const existing = view.servers.find(({ serverId }) => serverId === request.serverId);
    view = { ...view, servers: [docsServer({ ...existing, enabled: request.enabled ?? true })] };
    return { ok: true, value: view };
  });
  const startMcpSignIn = vi.fn(
    () =>
      new Promise<BackendResult<McpSettingsView>>((resolve) => {
        settleSignIn = resolve;
      }),
  );
  const cancelMcpSignIn = vi.fn(async () => ({ ok: true, value: view }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      subscribeToPluginSettings: vi.fn(() => () => undefined),
      getPluginSettings: vi.fn(async () => ({
        ok: true,
        value: { secureStorageAvailable: true, plugins: [], defaultProviders: { search: null, read: null } },
      })),
      getWispPluginAccess: vi.fn(),
      getMcpSettings: vi.fn(async () => ({ ok: true, value: view })),
      subscribeToMcpSettings: vi.fn(() => () => undefined),
      getWispMcpAccess: vi.fn(async ({ conversationId }: { conversationId: string }) => ({
        ok: true,
        value: { conversationId, revision: "r1", grants: [] },
      })),
      saveMcpServer,
      startMcpSignIn,
      cancelMcpSignIn,
      finishMcpSignIn: vi.fn(),
      testMcpConnection: vi.fn(),
      refreshMcpTools: vi.fn(),
      removeMcpServer: vi.fn(),
    },
  });
  return {
    saveMcpServer,
    startMcpSignIn,
    cancelMcpSignIn,
    settle: (servers: McpServerSummary[]) => settleSignIn?.({ ok: true, value: { ...view, servers } }),
  };
}

describe("PluginSettingsSection plugins that sign in through the browser", () => {
  it("connects in one step: saves the connection and starts the sign-in", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection wisps={WISPS} />);

    await user.click(await screen.findByRole("button", { name: "Connect Docs" }));
    expect(screen.getByText("You approve access in your browser.")).toBeVisible();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(api.saveMcpServer).toHaveBeenCalledWith({
      name: "Docs",
      endpoint: "https://mcp.docs.example.com/mcp",
      authMode: "oauth",
      preset: "docs",
      enabled: true,
    });
    await waitFor(() => expect(api.startMcpSignIn).toHaveBeenCalledWith({ serverId: "docs-1" }));
    expect(await screen.findByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();

    api.settle([docsServer({ state: "connected" })]);
    expect(await screen.findByRole("status")).toHaveTextContent("Connected to Docs. Choose which Wisps can use it.");
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
    expect(api.startMcpSignIn).toHaveBeenCalledTimes(1);
  });

  it("starts the sign-in once under React's development checks and keeps Sign in disabled while it waits", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(
      <StrictMode>
        <PluginSettingsSection />
      </StrictMode>,
    );

    await user.click(await screen.findByRole("button", { name: "Connect Docs" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
    expect(api.startMcpSignIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers to sign in when the connection needs it and lets the user cancel", async () => {
    const api = setup([docsServer()]);
    const user = userEvent.setup();
    render(<PluginSettingsSection wisps={WISPS} />);

    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    expect(connected.getByRole("button", { name: "Manage Docs" })).toHaveTextContent("Needs sign-in");
    await user.click(connected.getByRole("button", { name: "Manage Docs" }));
    // Opening it does not start a sign-in by itself.
    expect(api.startMcpSignIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(api.cancelMcpSignIn).toHaveBeenCalledWith({ serverId: "docs-1" }));
  });

  it("turns the plugin off from its page at once, without a save step", async () => {
    const api = setup([docsServer({ state: "connected" })]);
    const user = userEvent.setup();
    render(<PluginSettingsSection initialPluginId={"docs" as never} />);

    await user.click(await screen.findByRole("switch", { name: "Enable Docs" }));
    await waitFor(() => expect(api.saveMcpServer).toHaveBeenCalledTimes(1));
    expect(api.saveMcpServer.mock.calls[0]?.[0]).toMatchObject({ serverId: "docs-1", enabled: false });
    expect(api.saveMcpServer.mock.calls[0]?.[0]).not.toHaveProperty("headerValue");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Docs" })).not.toBeChecked());
  });
});
