import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { McpServerSummary, McpSettingsView, WispMcpAccessView } from "../../shared/mcp";
import { McpSettingsSection } from "./mcp-settings-section";

function setup(initial: McpSettingsView) {
  const getMcpSettings = vi.fn(async () => ({ ok: true, value: initial }));
  const saveMcpServer = vi.fn(async (request: { name: string }) => ({
    ok: true,
    value: {
      secureStorageAvailable: true,
      servers: [
        {
          serverId: "server-1",
          name: request.name,
          endpoint: "https://api.example.com/mcp",
          authMode: "none",
          enabled: true,
          state: "configured",
          headerConfigured: false,
          lastDiscoveredAt: null,
          tools: [],
        },
      ],
    } satisfies McpSettingsView,
  }));
  const testMcpConnection = vi.fn(async (_payload?: Record<string, unknown>) => ({
    ok: true,
    value: { message: "Connected. 3 tools available." },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getMcpSettings,
      saveMcpServer,
      testMcpConnection,
      removeMcpServer: vi.fn(),
      refreshMcpTools: vi.fn(),
      startMcpSignIn: vi.fn(),
      cancelMcpSignIn: vi.fn(),
      subscribeToMcpSettings: vi.fn(() => () => undefined),
    },
  });
  return { getMcpSettings, saveMcpServer, testMcpConnection };
}

describe("McpSettingsSection", () => {
  it("sends only fields the test endpoint accepts", async () => {
    const user = userEvent.setup();
    const { testMcpConnection } = setup({ secureStorageAvailable: true, servers: [] });
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Add MCP server" }));
    await user.type(await screen.findByLabelText("Name"), "Test Server");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(testMcpConnection).toHaveBeenCalledTimes(1));
    const payload = testMcpConnection.mock.calls[0]?.[0] as Record<string, unknown>;
    // "name" is rejected by the test endpoint's contract.
    expect(payload).not.toHaveProperty("name");
    expect(payload).toMatchObject({ endpoint: "https://api.example.com/mcp", authMode: "none" });
    expect(await screen.findByText("Connected. 3 tools available.")).toBeInTheDocument();
  });

  it("opens the created server after saving so it cannot be duplicated", async () => {
    const user = userEvent.setup();
    const { saveMcpServer } = setup({ secureStorageAvailable: true, servers: [] });
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Add MCP server" }));
    await user.type(await screen.findByLabelText("Name"), "Test Server");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1));
    // The form left add mode: it now manages the saved server, so saving
    // again updates it instead of creating a second one.
    expect(await screen.findByRole("heading", { name: "Test Server" })).toBeInTheDocument();
    expect(screen.getByText("Connection saved.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(2));
    expect(saveMcpServer.mock.calls[1]?.[0]).toMatchObject({ serverId: "server-1" });
    await user.click(screen.getByRole("button", { name: "Back to MCP servers" }));
    expect(await screen.findByRole("button", { name: "Manage Test Server" })).toBeInTheDocument();
  });
});

describe("McpSettingsSection drill-in", () => {
  const oauthServer: McpSettingsView = {
    secureStorageAvailable: true,
    servers: [
      {
        serverId: "server-1",
        name: "Linear MCP",
        endpoint: "https://mcp.linear.app/mcp",
        authMode: "oauth",
        enabled: true,
        state: "needs_sign_in",
        headerConfigured: false,
        lastDiscoveredAt: null,
        tools: [],
      },
    ],
  };

  function setupWithServer() {
    const cancelMcpSignIn = vi.fn(async () => ({ ok: true, value: oauthServer }));
    let settleSignIn: ((result: unknown) => void) | undefined;
    const startMcpSignIn = vi.fn(
      () =>
        new Promise((resolve) => {
          settleSignIn = resolve;
        }),
    );
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getMcpSettings: vi.fn(async () => ({ ok: true, value: oauthServer })),
        saveMcpServer: vi.fn(),
        testMcpConnection: vi.fn(),
        removeMcpServer: vi.fn(),
        refreshMcpTools: vi.fn(),
        startMcpSignIn,
        cancelMcpSignIn,
        subscribeToMcpSettings: vi.fn(() => () => undefined),
      },
    });
    return { cancelMcpSignIn, startMcpSignIn, settle: (result: unknown) => settleSignIn?.(result) };
  }

  it("opens the server form in place and returns to the list without stacking a dialog", async () => {
    const user = userEvent.setup();
    setupWithServer();
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Manage Linear MCP" }));
    expect(await screen.findByLabelText("Endpoint URL")).toHaveValue("https://mcp.linear.app/mcp");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to MCP servers" }));
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage Linear MCP" })).toBeInTheDocument();
  });

  it("cancels a pending browser sign-in instead of waiting for the timeout", async () => {
    const user = userEvent.setup();
    const { cancelMcpSignIn, settle } = setupWithServer();
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Manage Linear MCP" }));
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Waiting for browser…" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(cancelMcpSignIn).toHaveBeenCalledWith({ serverId: "server-1" }));

    settle({ ok: false, error: { code: "aborted", message: "The sign-in was cancelled.", retryable: false } });
    // A cancel the user asked for reads as a status, not an error.
    expect(await screen.findByRole("status")).toHaveTextContent("The sign-in was cancelled.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("keeps a waiting sign-in cancellable after leaving the form and returning", async () => {
    const user = userEvent.setup();
    const { cancelMcpSignIn, startMcpSignIn } = setupWithServer();
    let pushView: ((view: McpSettingsView) => void) | undefined;
    window.wisp.subscribeToMcpSettings = vi.fn((listener: (view: McpSettingsView) => void) => {
      pushView = listener;
      return () => undefined;
    });
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Manage Linear MCP" }));
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    // The backend announces the waiting sign-in to every window.
    act(() => pushView?.({ ...oauthServer, servers: [{ ...oauthServer.servers[0]!, signInPending: true }] }));

    await user.click(screen.getByRole("button", { name: "Back to MCP servers" }));
    await user.click(await screen.findByRole("button", { name: "Manage Linear MCP" }));

    expect(screen.getByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove connection" })).toBeDisabled();
    expect(startMcpSignIn).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(cancelMcpSignIn).toHaveBeenCalledWith({ serverId: "server-1" }));
    // The cancel result no longer reports a waiting sign-in.
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("McpSettingsSection Wisp access", () => {
  const WISPS = [
    { id: "researcher", name: "Researcher" },
    { id: "writer", name: "Writer" },
  ];

  function server(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
    return {
      serverId: "bitfinance",
      name: "BitFinance",
      endpoint: "https://vps.example.ts.net/mcp",
      authMode: "header",
      headerName: "Authorization",
      enabled: true,
      state: "connected",
      headerConfigured: true,
      lastDiscoveredAt: "2026-10-08T12:00:00.000Z",
      tools: [
        { name: "list_bills", alias: "mcp_x_list_bills", label: "list_bills", description: "", fingerprint: "f1" },
      ],
      ...overrides,
    };
  }

  function setupAccess(servers: McpServerSummary[]) {
    const views: Record<string, WispMcpAccessView> = {
      researcher: {
        conversationId: "researcher",
        revision: "researcher-revision",
        grants: [
          { serverId: "bitfinance", access: "use_with_approval" },
          { serverId: "other", access: "use_with_approval" },
        ],
      },
      writer: {
        conversationId: "writer",
        revision: "writer-revision",
        grants: [
          { serverId: "bitfinance", access: "none" },
          { serverId: "other", access: "use_with_approval" },
        ],
      },
    };
    const getWispMcpAccess = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
      ok: true,
      value: views[conversationId]!,
    }));
    const saveWispMcpAccess = vi.fn(async (request: WispMcpAccessView) => ({
      ok: true,
      value: { ...request, revision: `${request.conversationId}-saved` },
    }));
    const view: McpSettingsView = { secureStorageAvailable: true, servers };
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getMcpSettings: vi.fn(async () => ({ ok: true, value: view })),
        saveMcpServer: vi.fn(),
        testMcpConnection: vi.fn(),
        removeMcpServer: vi.fn(),
        refreshMcpTools: vi.fn(),
        startMcpSignIn: vi.fn(),
        cancelMcpSignIn: vi.fn(),
        subscribeToMcpSettings: vi.fn(() => () => undefined),
        getWispMcpAccess,
        saveWispMcpAccess,
      },
    });
    return { getWispMcpAccess, saveWispMcpAccess };
  }

  async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
    act(() => trigger.focus());
    await user.keyboard("{Enter}");
  }

  it("counts Wisps with access and grants a Wisp access from the server, keeping its other servers", async () => {
    const { saveWispMcpAccess } = setupAccess([server()]);
    const user = userEvent.setup();
    render(<McpSettingsSection wisps={WISPS} />);

    expect(await screen.findByRole("button", { name: "Manage BitFinance" })).toHaveTextContent("1 Wisp with access");
    await user.click(screen.getByRole("button", { name: "Manage BitFinance" }));
    const writer = await screen.findByRole("combobox", { name: "Writer access" });
    expect(writer).toHaveTextContent("No access");
    expect(screen.getByRole("combobox", { name: "Researcher access" })).toHaveTextContent("Use with approval");
    expect(screen.getByRole("button", { name: "Save Wisp access" })).toBeDisabled();

    await openSelect(user, writer);
    await user.click(screen.getByRole("option", { name: "Use with approval" }));
    await user.click(screen.getByRole("button", { name: "Save Wisp access" }));

    expect(saveWispMcpAccess).toHaveBeenCalledTimes(1);
    expect(saveWispMcpAccess).toHaveBeenCalledWith({
      conversationId: "writer",
      revision: "writer-revision",
      grants: [
        { serverId: "other", access: "use_with_approval" },
        { serverId: "bitfinance", access: "use_with_approval" },
      ],
    });
    expect(await screen.findByText("Wisp access saved.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to MCP servers" }));
    expect(await screen.findByRole("button", { name: "Manage BitFinance" })).toHaveTextContent("2 Wisps with access");
  });

  it("only offers revoking access while the connection cannot be granted", async () => {
    setupAccess([server({ enabled: false })]);
    const user = userEvent.setup();
    render(<McpSettingsSection wisps={WISPS} />);

    await user.click(await screen.findByRole("button", { name: "Manage BitFinance" }));
    expect(await screen.findByText(/Enable this connection before giving Wisps access/)).toBeVisible();
    await openSelect(user, screen.getByRole("combobox", { name: "Writer access" }));
    expect(screen.getByRole("option", { name: "Use with approval" })).toHaveAttribute("aria-disabled", "true");
  });

  it("asks to refresh tools when a connection has none yet", async () => {
    setupAccess([server({ state: "configured", tools: [], lastDiscoveredAt: null })]);
    const user = userEvent.setup();
    render(<McpSettingsSection wisps={WISPS} />);

    await user.click(await screen.findByRole("button", { name: "Manage BitFinance" }));
    expect(await screen.findByText(/No tools discovered yet/)).toBeVisible();
  });
});
