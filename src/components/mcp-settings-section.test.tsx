import { render, screen, waitFor } from "@testing-library/react";
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

  it("closes the add dialog after creating a server so it cannot be duplicated", async () => {
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
