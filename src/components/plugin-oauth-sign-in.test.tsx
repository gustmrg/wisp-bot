import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BackendResult } from "../../shared/contracts";
import type { PluginSettingsView, PluginSummary } from "../../shared/plugins";
import { PluginSettingsSection } from "./plugin-settings-section";

// Linear stands in for a plugin that signs in with the user's OAuth client.
vi.mock("../../shared/plugins", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shared/plugins")>();
  const catalog = original.PLUGIN_CATALOG.map((entry) =>
    entry.id === "linear"
      ? {
          ...entry,
          credentialLabel: "the cloud console",
          credentialUrl: "https://console.example.com/credentials",
          signIn: { clientHelp: "Create a Desktop app OAuth client.", setupUrl: "https://example.com/setup" },
        }
      : entry,
  );
  return {
    ...original,
    PLUGIN_CATALOG: catalog,
    pluginCatalogEntry: (id: string) => catalog.find((entry) => entry.id === id),
  };
});

function linear(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "linear",
    name: "Linear",
    description: "Find, read, create, update, and comment on Linear issues.",
    supportsWrite: true,
    configured: false,
    enabled: false,
    ...overrides,
  };
}

function setup(plugin: PluginSummary = linear()) {
  let view: PluginSettingsView = {
    secureStorageAvailable: true,
    plugins: [plugin],
    defaultProviders: { search: null, read: null },
  };
  let push: ((next: PluginSettingsView) => void) | undefined;
  let settle: ((result: BackendResult<PluginSettingsView>) => void) | undefined;
  const startPluginSignIn = vi.fn(
    (_request: { pluginId: string; clientId?: string; clientSecret?: string }) =>
      new Promise<BackendResult<PluginSettingsView>>((resolve) => {
        settle = resolve;
      }),
  );
  const cancelPluginSignIn = vi.fn(async () => ({ ok: true, value: view }));
  const finishPluginSignIn = vi.fn(async () => ({ ok: true, value: view }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getPluginSettings: vi.fn(async () => ({ ok: true, value: view })),
      subscribeToPluginSettings: vi.fn((listener: (next: PluginSettingsView) => void) => {
        push = listener;
        return () => undefined;
      }),
      getWispPluginAccess: vi.fn(async ({ conversationId }: { conversationId: string }) => ({
        ok: true,
        value: { conversationId, revision: "r", grants: [], webProviders: { search: null, read: null } },
      })),
      testPluginConnection: vi.fn(async () => ({ ok: true, value: { message: "Connected." } })),
      startPluginSignIn,
      cancelPluginSignIn,
      finishPluginSignIn,
      getMcpSettings: vi.fn(async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } })),
      subscribeToMcpSettings: vi.fn(() => () => undefined),
      getWispMcpAccess: vi.fn(),
    },
  });
  return {
    startPluginSignIn,
    cancelPluginSignIn,
    finishPluginSignIn,
    push: (next: PluginSummary) => {
      view = { ...view, plugins: [next] };
      act(() => push?.(view));
    },
    settle: (next: PluginSummary) => {
      view = { ...view, plugins: [next] };
      act(() => settle?.({ ok: true, value: view }));
    },
  };
}

describe("PluginSettingsSection plugins that sign in with the user's OAuth client", () => {
  it("connects with the client, waits for the browser, and finishes with a pasted address", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection wisps={[{ id: "one", name: "One" }]} />);

    await user.click(await screen.findByRole("button", { name: "Connect Linear" }));
    expect(screen.getByText(/Create a Desktop app OAuth client/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Setup guide/ })).toHaveAttribute("href", "https://example.com/setup");
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    await user.type(screen.getByLabelText("Client ID"), " client-1 ");
    await user.type(screen.getByLabelText("Client secret"), "secret-1");
    await user.click(connect);

    expect(api.startPluginSignIn).toHaveBeenCalledWith({
      pluginId: "linear",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
    expect(await screen.findByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
    // This device cannot receive the redirect: the backend shows the page to open by hand.
    api.push(linear({ signInPending: true, signInUrl: "https://accounts.example.com/authorize?state=s" }));
    expect(screen.getByRole("link", { name: /Open the sign-in page/ })).toHaveAttribute(
      "href",
      "https://accounts.example.com/authorize?state=s",
    );
    await user.type(screen.getByLabelText("Address after sign-in"), "http://127.0.0.1:1/callback?code=c&state=s");
    await user.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(api.finishPluginSignIn).toHaveBeenCalledWith({
      pluginId: "linear",
      redirectUrl: "http://127.0.0.1:1/callback?code=c&state=s",
    });

    api.settle(linear({ configured: true, enabled: true, account: "me@example.com" }));
    // The connect form gives way to the plugin's page.
    expect(await screen.findByText("Signed in as me@example.com.")).toBeVisible();
    const manage = within(screen.getByRole("region", { name: "Linear" }));
    expect(manage.getByText("Connected to Linear. Choose which Wisps can use it.")).toBeVisible();
    expect(manage.getByRole("button", { name: "Sign in again" })).toBeEnabled();
  });

  it("cancels a waiting sign-in", async () => {
    const api = setup();
    const user = userEvent.setup();
    render(<PluginSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Connect Linear" }));
    await user.type(screen.getByLabelText("Client ID"), "client-1");
    await user.type(screen.getByLabelText("Client secret"), "secret-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(api.cancelPluginSignIn).toHaveBeenCalledWith({ pluginId: "linear" }));
  });

  it("asks to sign in again when access expired, with the saved client", async () => {
    const api = setup(linear({ configured: true, enabled: true, needsSignIn: true, account: "me@example.com" }));
    const user = userEvent.setup();
    render(<PluginSettingsSection />);

    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    expect(connected.getByRole("button", { name: "Manage Linear" })).toHaveTextContent("Needs sign-in");
    await user.click(connected.getByRole("button", { name: "Manage Linear" }));
    expect(screen.getByText(/access expired or was revoked/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(api.startPluginSignIn).toHaveBeenCalledWith({ pluginId: "linear" });
  });

  it("warns that another OAuth client removes the plugin from every Wisp", async () => {
    const api = setup(linear({ configured: true, enabled: true, account: "me@example.com" }));
    const user = userEvent.setup();
    render(<PluginSettingsSection initialPluginId="linear" />);

    await user.click(await screen.findByRole("button", { name: "Use another OAuth client" }));
    expect(screen.getByText(/removes Linear from every Wisp/)).toBeVisible();
    await user.type(screen.getByLabelText("Client ID"), "client-2");
    await user.type(screen.getByLabelText("Client secret"), "secret-2");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(api.startPluginSignIn).toHaveBeenCalledWith({
      pluginId: "linear",
      clientId: "client-2",
      clientSecret: "secret-2",
    });
  });
});
