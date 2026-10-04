import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BackendResult } from "../../shared/contracts";
import {
  PLUGIN_CATALOG,
  type PluginGrant,
  type SaveWispPluginAccessRequest,
  type WispPluginAccessView,
} from "../../shared/plugins";
import { WispPluginSettings } from "./wisp-plugin-settings";
import { WispDetails } from "./wisp-details";

function setup({ available = true, grants = [] }: { available?: boolean; grants?: ReadonlyArray<PluginGrant> } = {}) {
  const getPluginSettings = vi.fn(async () => ({
    ok: true,
    value: {
      secureStorageAvailable: true,
      plugins: PLUGIN_CATALOG.map((plugin) => ({ ...plugin, configured: available, enabled: available })),
    },
  }));
  const getWispPluginAccess = vi.fn(
    async ({ conversationId }: { conversationId: string }): Promise<BackendResult<WispPluginAccessView>> => ({
      ok: true,
      value: { conversationId, grants, revision: "original-revision" },
    }),
  );
  const saveWispPluginAccess = vi.fn(
    async (request: SaveWispPluginAccessRequest): Promise<BackendResult<WispPluginAccessView>> => ({
      ok: true,
      value: request,
    }),
  );
  const getMcpSettings = vi.fn(async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }));
  const getWispMcpAccess = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
    ok: true,
    value: { conversationId, grants: [], revision: "mcp-original-revision" },
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
  return { getPluginSettings, getWispPluginAccess, saveWispPluginAccess };
}

async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
}

describe("WispPluginSettings", () => {
  it("defaults to no access and saves different read and write grants for only the selected Wisp", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    const web = await screen.findByRole("combobox", { name: "Web search access" });
    expect(web).toHaveTextContent("No access");
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    await openSelect(user, web);
    expect(screen.queryByRole("option", { name: "Read and write" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Read only" }));
    await openSelect(user, screen.getByRole("combobox", { name: "Linear access" }));
    await user.click(screen.getByRole("option", { name: "Read and write" }));
    expect(api.saveWispPluginAccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "original-revision",
      grants: [
        { pluginId: "web-search", access: "read" },
        { pluginId: "linear", access: "write" },
        { pluginId: "firecrawl", access: "none" },
      ],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Access settings saved for this Wisp.");
  });

  it("disables new grants for unavailable plugins but permits revocation", async () => {
    const api = setup({ available: false, grants: [{ pluginId: "linear", access: "write" }] });
    const user = userEvent.setup();
    render(<WispPluginSettings conversationId="researcher" />);
    await openSelect(user, await screen.findByRole("combobox", { name: "Linear access" }));
    expect(screen.getByRole("option", { name: "Read only" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Read and write" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "No access" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "researcher",
      revision: "original-revision",
      grants: [
        { pluginId: "web-search", access: "none" },
        { pluginId: "linear", access: "none" },
        { pluginId: "firecrawl", access: "none" },
      ],
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
    expect(screen.queryByText("Plugin access saved for this Wisp.")).not.toBeInTheDocument();
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
        },
      });
    });
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    const user = userEvent.setup();
    await openSelect(user, screen.getByRole("combobox", { name: "Web search access" }));
    await user.click(screen.getByRole("option", { name: "Read only" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "second" }));
  });

  it("reloads a rejected stale form without replaying its previous grants", async () => {
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
      value: { conversationId: "researcher", grants: [], revision: "replacement-revision" },
    });
    await user.click(screen.getByRole("button", { name: "Reload access settings" }));
    const web = await screen.findByRole("combobox", { name: "Web search access" });
    expect(screen.getByRole("combobox", { name: "Linear access" })).toHaveTextContent("No access");
    expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
    expect(api.saveWispPluginAccess).toHaveBeenCalledTimes(1);
    await openSelect(user, web);
    await user.click(screen.getByRole("option", { name: "Read only" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(api.saveWispPluginAccess).toHaveBeenLastCalledWith({
      conversationId: "researcher",
      revision: "replacement-revision",
      grants: [
        { pluginId: "web-search", access: "read" },
        { pluginId: "linear", access: "none" },
        { pluginId: "firecrawl", access: "none" },
      ],
    });
  });

  it("reloads global connections every time the Access tab opens", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(
      <WispDetails
        chat={{
          id: "researcher",
          kind: "wisp",
          name: "Researcher",
          label: "Research",
          description: "",
          shape: "circle",
          notifyOnUpdatesEnabled: true,
          preview: "Ready",
          timestamp: "Now",
        }}
        onChange={vi.fn()}
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
