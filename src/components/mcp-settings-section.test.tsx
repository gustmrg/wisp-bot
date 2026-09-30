import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { McpSettingsView } from "../../shared/mcp";
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

  it("returns to the server list after creating a server so it cannot be duplicated", async () => {
    const user = userEvent.setup();
    const { saveMcpServer } = setup({ secureStorageAvailable: true, servers: [] });
    render(<McpSettingsSection />);

    await user.click(await screen.findByRole("button", { name: "Add MCP server" }));
    await user.type(await screen.findByLabelText("Name"), "Test Server");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(1));
    // The dialog returned to its empty add state instead of keeping the
    // submitted draft, and the saved server appears as its own card.
    await waitFor(() => expect(screen.queryByLabelText("Name")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Manage Test Server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add MCP server" })).toBeInTheDocument();
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
