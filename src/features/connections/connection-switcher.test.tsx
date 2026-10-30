import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionsView } from "../../../shared/connections";
import { ActiveConnectionContext } from "./active-connection";
import { ConnectionSwitcher } from "./connection-switcher";

const LOCAL = { id: "local", kind: "local", name: "This computer", paired: true } as const;
const SERVER = {
  id: "home",
  kind: "url",
  name: "Home server",
  url: "https://test-host.invalid",
  paired: true,
} as const;

function view(changes: Partial<ConnectionsView> = {}): ConnectionsView {
  return {
    activeId: "local",
    profiles: [LOCAL, SERVER],
    status: { profileId: "local", phase: "local", epoch: 1 },
    secureStorageAvailable: true,
    ...changes,
  };
}

const activateConnection = vi.fn();
const getRemoteAccess = vi.fn();

beforeEach(() => {
  activateConnection.mockReset().mockResolvedValue({ ok: true, value: view() });
  getRemoteAccess.mockReset().mockResolvedValue({ ok: true, value: { enabled: false } });
  Object.defineProperty(window, "wisp", { configurable: true, value: { activateConnection, getRemoteAccess } });
});

function renderSwitcher(value: ConnectionsView | null, onManage = vi.fn(), rail = false) {
  render(
    <ActiveConnectionContext.Provider value={value}>
      <ConnectionSwitcher rail={rail} onManage={onManage} />
    </ActiveConnectionContext.Provider>,
  );
  return onManage;
}

describe("ConnectionSwitcher", () => {
  it.each([
    ["a single connection", view({ profiles: [LOCAL] })],
    ["the browser app", view({ canManage: false })],
    ["no connection gate", null],
  ])("stays out of the way with %s", (_name, value) => {
    renderSwitcher(value);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the connection in use and how it is doing", () => {
    renderSwitcher(view({ activeId: "home", status: { profileId: "home", phase: "reconnecting", epoch: 1 } }));
    expect(screen.getByRole("button", { name: "Reconnecting to Home server. Switch connection" })).toHaveTextContent(
      "Home server",
    );
  });

  it("keeps the name in its label when folded to the rail", () => {
    renderSwitcher(view(), vi.fn(), true);
    const button = screen.getByRole("button", { name: "Using This computer. Switch connection" });
    expect(button).not.toHaveTextContent("This computer");
    expect(button).toHaveAttribute("title", "Using This computer");
  });

  it("lists every connection, marks the one in use, and switches to another", async () => {
    const user = userEvent.setup();
    renderSwitcher(view());
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));

    const list = await screen.findByRole("list", { name: "Connections" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("This computer").closest("[aria-current]")).not.toBeNull();
    expect(within(list).getByText("test-host.invalid")).toBeVisible();
    expect(within(list).queryByRole("button", { name: "Switch to This computer" })).toBeNull();

    await user.click(within(list).getByRole("button", { name: "Switch to Home server" }));
    expect(activateConnection).toHaveBeenCalledWith({ id: "home" });
  });

  it("says when another connection is not paired yet", async () => {
    const user = userEvent.setup();
    renderSwitcher(view({ profiles: [LOCAL, { ...SERVER, paired: false }] }));
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));
    expect(await screen.findByText("test-host.invalid · Not paired yet")).toBeVisible();
  });

  it("explains why a switch failed and keeps the list open", async () => {
    const user = userEvent.setup();
    activateConnection.mockResolvedValue({ ok: false, error: { message: "Wisp is busy setting up a server." } });
    renderSwitcher(view());
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));
    await user.click(await screen.findByRole("button", { name: "Switch to Home server" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wisp is busy setting up a server.");
    expect(screen.getByRole("button", { name: "Switch to Home server" })).toBeEnabled();
  });

  it("warns that leaving this computer stops its Wisps", async () => {
    const user = userEvent.setup();
    renderSwitcher(view());
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));
    expect(await screen.findByText(/stops the Wisps on this computer/)).toBeVisible();
  });

  it("does not warn when remote access keeps this computer's server running", async () => {
    const user = userEvent.setup();
    getRemoteAccess.mockResolvedValue({ ok: true, value: { enabled: true } });
    renderSwitcher(view());
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));
    await screen.findByRole("list", { name: "Connections" });
    await waitFor(() => expect(getRemoteAccess).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/stops the Wisps on this computer/)).toBeNull());
  });

  it("does not warn when leaving a server, whose Wisps keep working", async () => {
    const user = userEvent.setup();
    renderSwitcher(view({ activeId: "home", status: { profileId: "home", phase: "connected", epoch: 1 } }));
    await user.click(screen.getByRole("button", { name: "Connected to Home server. Switch connection" }));
    await screen.findByRole("list", { name: "Connections" });
    expect(getRemoteAccess).not.toHaveBeenCalled();
    expect(screen.queryByText(/stops the Wisps on this computer/)).toBeNull();
  });

  it("opens the connections in Settings", async () => {
    const user = userEvent.setup();
    const onManage = renderSwitcher(view());
    await user.click(screen.getByRole("button", { name: /Switch connection/ }));
    await user.click(await screen.findByRole("button", { name: "Manage connections" }));
    expect(onManage).toHaveBeenCalledOnce();
  });
});
