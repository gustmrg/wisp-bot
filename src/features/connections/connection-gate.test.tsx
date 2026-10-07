import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionsView, ConnectionStatus, SshServerCheck } from "../../../shared/connections";
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
    cancelServerInstall: vi.fn(ok),
    listSshHosts: vi.fn(async () => ({ ok: true as const, value: [] })),
    checkSshServer: vi.fn(
      async (): Promise<
        | { ok: true; value: SshServerCheck }
        | { ok: false; error: { code: string; message: string; retryable: boolean } }
      > => ({ ok: true, value: { appVersion: "1.0.0", addedKey: false } }),
    ),
    cancelSshCheck: vi.fn(ok),
    answerSshPrompt: vi.fn(ok),
    listTailnetMachines: vi.fn(async () => ({ ok: true as const, value: [] })),
    enableLinger: vi.fn(ok),
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
    // Over SSH, Retry connects as the person first, so the host key can be trusted here.
    expect(api.checkSshServer).toHaveBeenCalledWith({ id: "pi" });
    await waitFor(() => expect(api.retryConnection).toHaveBeenCalled());
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
    expect(api.checkSshServer).toHaveBeenCalledWith({ id: "pi" });
    await waitFor(() => expect(api.installServer).toHaveBeenCalledWith({ id: "pi" }));
  });

  it("asks OpenSSH's questions while it checks the server, and stops on a failed check", async () => {
    const { api, push } = bridge(view({ phase: "error", message: "Not trusted." }));
    let finish: (value: Awaited<ReturnType<typeof api.checkSshServer>>) => void = () => undefined;
    api.checkSshServer.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByText("Connecting to raspberrypi over SSH…")).toBeVisible();
    await push({
      ...view({ phase: "error", message: "Not trusted." }),
      sshPrompt: {
        id: 7,
        kind: "hostKey",
        host: "raspberrypi (100.64.0.1)",
        keyType: "ED25519",
        fingerprint: "SHA256:abc",
        message: "The authenticity of host…",
      },
    });
    expect(screen.getByRole("group", { name: "Trust raspberrypi?" })).toHaveTextContent("SHA256:abc");
    await userEvent.click(screen.getByRole("button", { name: "Trust and continue" }));
    expect(api.answerSshPrompt).toHaveBeenCalledWith({ id: 7, answer: "yes" });
    await push({
      ...view({ phase: "error", message: "Not trusted." }),
      sshPrompt: { id: 8, kind: "secret", message: "me@raspberrypi's password:" },
    });
    await userEvent.type(screen.getByLabelText("me@raspberrypi's password"), "hunter2{Enter}");
    expect(api.answerSshPrompt).toHaveBeenCalledWith({ id: 8, answer: "hunter2" });
    await act(async () =>
      finish({
        ok: false,
        error: { code: "unavailable", message: "raspberrypi did not accept the password.", retryable: true },
      }),
    );
    expect(await screen.findByText("raspberrypi did not accept the password.")).toBeVisible();
    expect(api.retryConnection).not.toHaveBeenCalled();
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

  it("lets the person cancel a setup in progress", async () => {
    const { api } = bridge(view({ phase: "connecting", message: "Installing…", installing: true }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cancel setup" }));
    expect(api.cancelServerInstall).toHaveBeenCalled();
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
    expect(screen.getByText(/pairs with it for you/)).toBeVisible();
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
    const added = view({ phase: "error", message: "Down." });
    added.profiles = [
      ...profiles,
      { id: "office", kind: "ssh", name: "Office", host: "office-box", user: "wisp", serverPort: 8787, paired: false },
    ];
    api.saveConnection.mockResolvedValueOnce({ ok: true, value: added });
    api.checkSshServer.mockResolvedValueOnce({ ok: true, value: { appVersion: "1.0.0", addedKey: true } });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(api.saveConnection).toHaveBeenCalledWith({
        kind: "ssh",
        name: "Office",
        host: "office-box",
        user: "wisp",
        serverPort: 8787,
      }),
    );
    // Then it connects once, and offers to install the server it did not find.
    expect(api.checkSshServer).toHaveBeenCalledWith({ id: "office" });
    expect(await screen.findByText(/Wisp added its own key there/)).toBeVisible();
    expect(screen.getByText(/The Wisp server is not installed on office-box yet\./)).toBeVisible();
    const panel = within(screen.getByRole("region", { name: "Connections" }));
    await userEvent.click(panel.getByRole("button", { name: "Install the Wisp server" }));
    await userEvent.click(panel.getByRole("button", { name: "Install and connect" }));
    // Checked moments ago: the setup does not check again.
    expect(api.checkSshServer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.installServer).toHaveBeenCalledWith({ id: "office" }));
    expect(await screen.findByRole("button", { name: /Add a server/ })).toBeVisible();
  });

  it("connects right away to a server that runs this app's version, and goes back to fix settings", async () => {
    const { api } = bridge(view({ phase: "error", message: "Down." }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Add a server/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Host" }), "office-box");
    const added = view({ phase: "error", message: "Down." });
    added.profiles = [
      ...profiles,
      { id: "office", kind: "ssh", name: "office-box", host: "office-box", serverPort: 8787, paired: false },
    ];
    api.saveConnection.mockResolvedValue({ ok: true, value: added });
    api.checkSshServer.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "office-box cannot be reached over SSH.", retryable: true },
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("office-box cannot be reached over SSH.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Change settings" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Host" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Host" }), "office-box.test.invalid");
    api.checkSshServer.mockResolvedValueOnce({
      ok: true,
      value: { appVersion: "1.0.0", installedVersion: "1.0.0", addedKey: false },
    });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    // The second save updates the server added by the first.
    await waitFor(() =>
      expect(api.saveConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "office", host: "office-box.test.invalid" }),
      ),
    );
    await waitFor(() => expect(api.activateConnection).toHaveBeenCalledWith({ id: "office" }));
  });
});
