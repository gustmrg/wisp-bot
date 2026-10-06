import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionsView, ConnectionStatus } from "../../../shared/connections";
import { useScreenActions } from "./active-connection";
import { ConnectionGate } from "./connection-gate";

const profiles: ConnectionsView["profiles"] = [
  { id: "local", kind: "local", name: "This computer", paired: true },
  { id: "pi", kind: "ssh", name: "Home server", host: "raspberrypi", user: "me", serverPort: 8787, paired: true },
];

function view(status: Partial<ConnectionStatus> & Pick<ConnectionStatus, "phase">, activeId = "pi"): ConnectionsView {
  return { activeId, profiles, status: { profileId: activeId, epoch: 1, ...status }, secureStorageAvailable: true };
}

function bridge(initial: ConnectionsView) {
  let push: (next: ConnectionsView) => void = () => undefined;
  const ok = async () => ({ ok: true as const, value: initial });
  const api = {
    getConnections: vi.fn(ok),
    saveConnection: vi.fn(ok),
    removeConnection: vi.fn(ok),
    activateConnection: vi.fn(ok),
    retryConnection: vi.fn(ok),
    installServer: vi.fn(ok),
    subscribeToConnections: vi.fn((listener: (next: ConnectionsView) => void) => {
      push = listener;
      return () => undefined;
    }),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return { api, push: (next: ConnectionsView) => act(() => push(next)) };
}

function ScreenActionProbe() {
  return <p>screen actions: {useScreenActions() ? "yes" : "no"}</p>;
}

function App({ onMount }: { onMount: () => void }) {
  const mounted = useRef(onMount);
  useEffect(() => mounted.current(), []);
  return <p>Workspace</p>;
}

describe("ConnectionGate", () => {
  it("shows the app on this computer and remounts it when the backend changes", async () => {
    const mounted = vi.fn();
    const { push } = bridge(view({ phase: "local" }, "local"));
    render(
      <ConnectionGate>
        <App onMount={mounted} />
      </ConnectionGate>,
    );
    expect(await screen.findByText("Workspace")).toBeVisible();
    expect(mounted).toHaveBeenCalledTimes(1);
    await push(view({ phase: "connected", epoch: 2 }));
    expect(screen.getByText("Workspace")).toBeVisible();
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("keeps the app during a reconnect and offers to retry", async () => {
    const mounted = vi.fn();
    const { api, push } = bridge(view({ phase: "connected" }));
    render(
      <ConnectionGate>
        <App onMount={mounted} />
      </ConnectionGate>,
    );
    await screen.findByText("Workspace");
    await push(view({ phase: "reconnecting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to Home server");
    expect(screen.getByText("Workspace")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(api.retryConnection).toHaveBeenCalled();
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("asks for a pairing code, or pairing over SSH, before showing the app", async () => {
    const { api } = bridge(view({ phase: "pairing_required", message: "Enter a pairing code." }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Pair with Home server" })).toBeVisible();
    expect(screen.queryByText("Workspace")).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Pairing code" }), "abcde-fghjk");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "pi", pairingCode: "abcde-fghjk" });
    await userEvent.click(screen.getByRole("button", { name: "Pair over SSH" }));
    expect(api.retryConnection).toHaveBeenCalled();
  });

  it("explains an error and lets the user retry or use this computer", async () => {
    const { api } = bridge(view({ phase: "error", message: "The SSH host key of raspberrypi is not trusted yet." }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("host key of raspberrypi");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.retryConnection).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use this computer instead" }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "local" });
  });

  it("offers to set the server up over SSH, after asking, when the connection fails", async () => {
    const { api } = bridge(view({ phase: "error", message: "wispctl is not installed on raspberrypi." }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Install the Wisp server" }));
    // Nothing runs on the other computer until the person confirms.
    expect(api.installServer).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Install the Wisp server" })).toHaveTextContent(
      "npx @gustmrg/wisp-server setup",
    );
    await userEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    expect(api.installServer).toHaveBeenCalledWith({ id: "pi" });
  });

  it("shows why the setup failed", async () => {
    const { api } = bridge(view({ phase: "error", message: "Down." }));
    api.installServer.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Node.js is missing on raspberrypi.", retryable: true },
    } as never);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Install the Wisp server" }));
    await userEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    expect(await screen.findByText("Node.js is missing on raspberrypi.")).toBeVisible();
  });

  it("does not offer a server setup for an address or this computer", async () => {
    bridge({
      ...view({ phase: "error", message: "Down." }),
      activeId: "u",
      profiles: [...profiles, { id: "u", kind: "url", name: "Tailnet", url: "https://x.ts.net", paired: false }],
    });
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Install the Wisp server" })).toBeNull();
  });

  it("in the browser app, offers only pairing with the server that served it", async () => {
    const web: ConnectionsView = {
      activeId: "server",
      profiles: [
        { id: "server", kind: "url", name: "wisp.example.ts.net", url: "https://wisp.example.ts.net", paired: false },
      ],
      status: { profileId: "server", phase: "pairing_required", epoch: 0, message: "Enter a pairing code." },
      secureStorageAvailable: true,
      canManage: false,
    };
    bridge(web);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Pair with wisp.example.ts.net" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use this computer instead" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a server/ })).toBeNull();
  });

  it("hides actions that need this computer's screen when Wisps run elsewhere", async () => {
    const { push } = bridge(view({ phase: "local" }, "local"));
    render(
      <ConnectionGate>
        <ScreenActionProbe />
      </ConnectionGate>,
    );
    expect(await screen.findByText("screen actions: yes")).toBeVisible();
    await push(view({ phase: "connected", epoch: 2 }));
    expect(await screen.findByText("screen actions: no")).toBeVisible();
  });

  it("asks where Wisps run on a new installation", async () => {
    const { api } = bridge(view({ phase: "choosing" }, "local"));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Where should your Wisps run?" })).toBeVisible();
    expect(screen.queryByText("Workspace")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /On a Wisp server/ }));
    expect(screen.getByRole("button", { name: /Add a server/ })).toBeVisible();
    // Someone without a server yet learns how to set one up.
    await userEvent.click(screen.getByText("How to set up a Wisp server"));
    expect(screen.getByText(/on the server for you/)).toBeVisible();
    expect(screen.getByRole("link", { name: /Full guide/ })).toHaveAttribute(
      "href",
      "https://github.com/gustmrg/wisp-bot/blob/main/docs/remote-server.md",
    );
    expect(api.activateConnection).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /On this computer/ }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "local" });
  });

  it("adds an SSH server from the connections list", async () => {
    const { api } = bridge(view({ phase: "error", message: "Down." }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Add a server/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Office");
    await userEvent.type(screen.getByRole("textbox", { name: "Host" }), "office-box");
    await userEvent.type(screen.getByRole("textbox", { name: "User (optional)" }), "wisp");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveConnection).toHaveBeenCalledWith({
        kind: "ssh",
        name: "Office",
        host: "office-box",
        user: "wisp",
        serverPort: 8787,
      }),
    );
    expect(await screen.findByRole("button", { name: /Add a server/ })).toBeVisible();
  });
});
