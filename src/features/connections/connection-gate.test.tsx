import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef } from "react";
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
    cancelServerInstall: vi.fn(ok),
    cancelConnection: vi.fn(ok),
    answerSshPrompt: vi.fn(ok),
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
  // A layout effect runs with the commit that shows "Workspace"; a passive one
  // may run after findByText resolves.
  useLayoutEffect(() => mounted.current(), []);
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

  it("asks what SSH needs to know, without remounting the app", async () => {
    const mounted = vi.fn();
    const { api, push } = bridge(view({ phase: "reconnecting" }));
    render(
      <ConnectionGate>
        <App onMount={mounted} />
      </ConnectionGate>,
    );
    await screen.findByText("Workspace");
    const hostKey = "ED25519 key fingerprint is SHA256:abc123.\nAre you sure you want to continue connecting?";
    await push({
      ...view({ phase: "reconnecting" }),
      sshPrompt: { id: "ssh-1", kind: "host_key", host: "raspberrypi", message: hostKey },
    });
    expect(await screen.findByRole("dialog", { name: "Trust raspberrypi?" })).toHaveTextContent("SHA256:abc123");
    const first = screen.getByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    expect(api.answerSshPrompt).toHaveBeenCalledWith({ id: "ssh-1", answer: "yes" });

    // Between two questions, the dialog stays open and the next one replaces the answered one.
    await push(view({ phase: "reconnecting" }));
    expect(screen.getByRole("dialog", { name: "Trust raspberrypi?" })).toBe(first);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await push({
      ...view({ phase: "reconnecting" }),
      sshPrompt: {
        id: "ssh-2",
        kind: "password",
        host: "raspberrypi",
        message: "me@raspberrypi's password:",
        keys: ["me@laptop (SHA256:xyz)"],
        retry: true,
      },
    });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to raspberrypi" });
    expect(dialog).toBe(first);
    expect(dialog).toHaveTextContent("me@laptop (SHA256:xyz)");
    expect(screen.getByRole("alert")).toHaveTextContent("That was not accepted");
    await userEvent.type(screen.getByLabelText("me@raspberrypi's password:"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Add key and connect" }));
    expect(api.answerSshPrompt).toHaveBeenLastCalledWith({ id: "ssh-2", answer: "hunter2" });

    await push({
      ...view({ phase: "reconnecting" }),
      sshPrompt: { id: "ssh-3", kind: "passphrase", host: "raspberrypi", message: "Enter passphrase for key:" },
    });
    await screen.findByRole("dialog", { name: "Unlock your SSH key" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.answerSshPrompt).toHaveBeenLastCalledWith({ id: "ssh-3" });
    await push(view({ phase: "reconnecting" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mounted).toHaveBeenCalledTimes(1);
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
    const since = Date.now() - 42_000;
    await push(
      view({
        phase: "reconnecting",
        retry: {
          since,
          attempt: 2,
          nextAttemptAt: Date.now() + 8_000,
          failures: [
            { at: since + 5_000, message: "raspberrypi cannot be reached over SSH." },
            { at: since + 17_000, message: "raspberrypi cannot be reached over SSH." },
          ],
        },
      }),
    );
    // Says how it is retrying: the attempt, and when the next one starts.
    expect(screen.getByRole("status")).toHaveTextContent(
      /Reconnecting to Home server.*Attempt 3 · next in \d+s · Wisps on it keep working/,
    );
    expect(screen.getByText("Workspace")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(api.retryConnection).toHaveBeenCalled();
    expect(mounted).toHaveBeenCalledTimes(1);
    // The details list each failed attempt, and keep the way back to this computer.
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const attempts = await screen.findByRole("list", { name: "Attempts" });
    expect(attempts).toHaveTextContent(/Attempt 1.*cannot be reached.*Attempt 2.*Attempt 3/);
    // A server that stays away must not keep the person from the Wisps on this computer.
    await userEvent.click(screen.getByRole("button", { name: "Use this computer instead" }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "local" });
  });

  it("turns the banner red and dims the app after a long time away", async () => {
    const { push } = bridge(view({ phase: "connected" }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByText("Workspace");
    await push(view({ phase: "reconnecting", retry: { since: Date.now() - 5 * 60_000, attempt: 9, failures: [] } }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Unreachable for 5 min.*Home server · still retrying/);
    expect(screen.getByRole("button", { name: "Edit connection" })).toBeVisible();
  });

  it("warns, until dismissed, when the server runs another version than this app", async () => {
    const { push } = bridge(view({ phase: "connected", serverVersion: "0.0.1" }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    // The banner shows once the opening splash has given way to the app.
    await screen.findByRole("button", { name: "Dismiss" });
    expect(screen.getByRole("status")).toHaveTextContent(
      /Home server runs Wisp server 0\.0\.1, older than this app.*Update it so every feature works/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await push(view({ phase: "connected", serverVersion: "999.0.0" }));
    expect(screen.getByRole("status")).toHaveTextContent(/newer than this app.*Update this app/);
    await push(view({ phase: "connected", serverVersion: __APP_VERSION__ }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers to update an older SSH server from the banner, after confirming", async () => {
    const { api } = bridge(view({ phase: "connected", serverVersion: "0.0.1" }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Update server" }));
    // Nothing runs on the server until the person confirms.
    expect(api.installServer).not.toHaveBeenCalled();
    // An update keeps the server's data and says so, instead of describing a first install.
    const dialog = await screen.findByRole("dialog", { name: /Update Home server to/ });
    expect(dialog).toHaveTextContent(/Kept:.*Interrupted:/);
    await userEvent.click(screen.getByRole("button", { name: "Update and reconnect" }));
    expect(api.installServer).toHaveBeenCalledWith({ id: "pi" });
  });

  it("offers no server update when the server is newer, or not reached over SSH", async () => {
    const { push } = bridge(view({ phase: "connected", serverVersion: "999.0.0" }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByRole("button", { name: "Dismiss" });
    expect(screen.getByRole("status")).toHaveTextContent(/newer than this app/);
    expect(screen.queryByRole("button", { name: "Update server" })).toBeNull();

    await push({
      ...view({ phase: "connected", serverVersion: "0.0.1" }),
      activeId: "u",
      profiles: [...profiles, { id: "u", kind: "url", name: "Tailnet", url: "https://x.ts.net", paired: true }],
      status: { profileId: "u", phase: "connected", epoch: 1, serverVersion: "0.0.1" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Tailnet runs Wisp server 0\.0\.1.*Update the server/);
    expect(screen.queryByRole("button", { name: "Update server" })).toBeNull();
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
    expect(await screen.findByText(/host key of raspberrypi/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.retryConnection).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use this computer instead" }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "local" });
  });

  it("offers to set the server up over SSH when it is not installed, saying what that does", async () => {
    const { api } = bridge(
      view({ phase: "error", message: "wispctl is not installed on raspberrypi.", failure: "not_installed" }),
    );
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Wisp is not installed on Home server" })).toBeVisible();
    expect(screen.getByText("Wisp can set it up for you").parentElement).toHaveTextContent(
      "the setup of @gustmrg/wisp-server",
    );
    await userEvent.click(screen.getByRole("button", { name: "Install on raspberrypi" }));
    expect(api.installServer).toHaveBeenCalledWith({ id: "pi" });
  });

  it("offers no setup for a failure a setup cannot fix", async () => {
    bridge(view({ phase: "error", message: "me@raspberrypi did not accept an SSH key.", failure: "auth" }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Could not sign in to Home server" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Install on/ })).toBeNull();
  });

  it("shows why the setup failed", async () => {
    const { api } = bridge(view({ phase: "error", message: "Down.", failure: "not_running" }));
    api.installServer.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Node.js is missing on raspberrypi.", retryable: true },
    } as never);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Install on raspberrypi" }));
    expect(await screen.findByText("Node.js is missing on raspberrypi.")).toBeVisible();
  });

  it("shows a setup step by step, and lets the person cancel it", async () => {
    const { api } = bridge(
      view({
        phase: "connecting",
        message: "Installing…",
        installing: true,
        serverVersion: "0.0.1",
        progress: {
          kind: "update",
          fromVersion: "0.0.1",
          steps: [
            { id: "download", state: "done", startedAt: 1_000, endedAt: 3_000 },
            { id: "install", state: "active", startedAt: Date.now(), detail: "Installing @gustmrg/wisp-server…" },
            { id: "service", state: "pending" },
            { id: "connect", state: "pending" },
          ],
        },
      }),
    );
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Updating Home server" })).toBeVisible();
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(steps).toHaveTextContent(/Done: Download wisp-server.*2\.0s/);
    expect(steps).toHaveTextContent(/In progress: Install wisp-server.*Installing @gustmrg\/wisp-server…/);
    // An update says where running Wisps stop.
    expect(steps).toHaveTextContent(/Restart the service.*Running Wisps stop here/);
    await userEvent.click(screen.getByRole("button", { name: "Cancel update" }));
    expect(api.cancelServerInstall).toHaveBeenCalled();
  });

  it("after a cancelled update, offers to keep the old version or update again", async () => {
    const { api } = bridge(
      view({
        phase: "error",
        failure: "cancelled",
        serverVersion: "0.0.1",
        message: "Installing the server was cancelled.",
        progress: {
          kind: "update",
          fromVersion: "0.0.1",
          steps: [
            { id: "download", state: "skipped", startedAt: 1_000, endedAt: 2_000 },
            { id: "install", state: "skipped" },
            { id: "service", state: "skipped" },
            { id: "connect", state: "skipped" },
          ],
        },
      }),
    );
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Update cancelled" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Home server still runs 0.0.1. Nothing was changed");
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("Cancelled by you");
    await userEvent.click(screen.getByRole("button", { name: "Continue with 0.0.1" }));
    expect(api.retryConnection).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Update again" }));
    expect(api.installServer).toHaveBeenCalledWith({ id: "pi" });
  });

  it("shows each step of connecting, waits on the person while SSH asks, and can be cancelled", async () => {
    const connecting = view({
      phase: "connecting",
      progress: {
        kind: "connect",
        steps: [
          { id: "reach", state: "done", startedAt: 1_000, endedAt: 1_300 },
          { id: "sign_in", state: "active", startedAt: Date.now() },
          { id: "server", state: "pending" },
          { id: "load", state: "pending" },
        ],
      },
    });
    const { api, push } = bridge(connecting);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Connecting to Home server" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent(
      /Done: Reach raspberrypi.*In progress: Sign in over SSH.*Waiting: Check the Wisp server/,
    );
    await push({
      ...connecting,
      sshPrompt: { id: "ssh-1", kind: "host_key", host: "raspberrypi", message: "fingerprint" },
    });
    // The card asks the question itself: no dialog opens over it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connecting to Home server" })).toBeVisible();
    expect(screen.getByRole("form", { name: "Trust raspberrypi?" })).toHaveTextContent("fingerprint");
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("Waiting for your answer");
    await userEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    expect(api.answerSshPrompt).toHaveBeenCalledWith({ id: "ssh-1", answer: "yes" });

    // The next question replaces the answered one in the same card.
    await push(connecting);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await push({
      ...connecting,
      sshPrompt: { id: "ssh-2", kind: "password", host: "raspberrypi", message: "me@raspberrypi's password:" },
    });
    expect(screen.getByRole("form", { name: "Sign in to raspberrypi" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "Trust raspberrypi?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // The card's Cancel stops connecting, which declines the question.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelConnection).toHaveBeenCalled();
    await push(connecting);
    await waitFor(() => expect(screen.queryByRole("form", { name: /Sign in to/ })).not.toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Steps" })).not.toHaveTextContent("Waiting for your answer");
  });

  it("opens no dialog for a question answered in the card when connecting then fails", async () => {
    const connecting = view({ phase: "connecting" });
    const { push } = bridge(connecting);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await push({
      ...connecting,
      sshPrompt: { id: "ssh-1", kind: "host_key", host: "raspberrypi", message: "fingerprint" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    await push(view({ phase: "error", failure: "auth", message: "raspberrypi turned the SSH login away." }));
    expect(await screen.findByRole("heading", { name: "Could not sign in to Home server" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Trust raspberrypi?" })).not.toBeInTheDocument();
  });

  it("keeps trying a server it cannot reach, and says why and when it tries next", async () => {
    const { api } = bridge(
      view({
        phase: "connecting",
        failure: "unreachable",
        message: "raspberrypi cannot be reached over SSH. Check that it is on.",
        retry: { since: Date.now() - 20_000, attempt: 3, nextAttemptAt: Date.now() + 8_000, failures: [] },
        progress: {
          kind: "connect",
          steps: [
            { id: "reach", state: "failed" },
            { id: "sign_in", state: "pending" },
          ],
        },
      }),
    );
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    expect(await screen.findByRole("heading", { name: "Cannot reach Home server" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/3 failed attempts · trying again in \d+s/);
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("Failed: Reach raspberrypiNo answer");
    expect(screen.getByText(/Check that it is on/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again now" }));
    expect(api.retryConnection).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(screen.getByRole("textbox", { name: "Host" })).toHaveValue("raspberrypi");
  });

  it("says which server it connected to after switching to it", async () => {
    const { push } = bridge(view({ phase: "local" }, "local"));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByText("Workspace");
    await push(view({ phase: "connecting", epoch: 2 }));
    await screen.findByRole("heading", { name: "Connecting to Home server" });
    await push(view({ phase: "connected", epoch: 2, serverVersion: __APP_VERSION__ }));
    expect(await screen.findByText("Connected to Home server")).toBeVisible();
    expect(screen.getByText(`me@raspberrypi · server ${__APP_VERSION__}`)).toBeVisible();
  });

  it("stops saying which server it connected to after Don't show again, on this device", async () => {
    window.localStorage.clear();
    const { push } = bridge(view({ phase: "local" }, "local"));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByText("Workspace");
    await push(view({ phase: "connecting", epoch: 2 }));
    await push(view({ phase: "connected", epoch: 2, serverVersion: __APP_VERSION__ }));
    await userEvent.click(await screen.findByRole("button", { name: "Don't show again" }));
    expect(screen.queryByText("Connected to Home server")).toBeNull();
    expect(window.localStorage.getItem("wisp-bot-connection-notices-off")).toBe("1");

    await push(view({ phase: "local", epoch: 3 }, "local"));
    await push(view({ phase: "connecting", epoch: 4 }));
    await push(view({ phase: "connected", epoch: 4, serverVersion: __APP_VERSION__ }));
    await screen.findByText("Workspace");
    expect(screen.queryByText("Connected to Home server")).toBeNull();
    window.localStorage.clear();
  });

  it("connects quietly as the app opens, and says so only when it took failed attempts", async () => {
    const { push } = bridge(view({ phase: "connecting" }));
    const { unmount } = render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByRole("heading", { name: "Connecting to Home server" });
    await push(view({ phase: "connected", serverVersion: __APP_VERSION__ }));
    await screen.findByText("Workspace");
    expect(screen.queryByText("Connected to Home server")).toBeNull();
    unmount();

    const retry = { since: Date.now() - 20_000, attempt: 2, failures: [] };
    const late = bridge(view({ phase: "connecting", failure: "unreachable", message: "Down.", retry }));
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    await screen.findByRole("heading", { name: "Cannot reach Home server" });
    await late.push(view({ phase: "connected", serverVersion: __APP_VERSION__ }));
    expect(await screen.findByText("Connected to Home server")).toBeVisible();
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
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("button", { name: /Install on/ })).toBeNull();
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

  it("in the browser app, asks only for a device name when opened from a pairing link", async () => {
    const web: ConnectionsView = {
      activeId: "server",
      profiles: [
        { id: "server", kind: "url", name: "wisp.example.ts.net", url: "https://wisp.example.ts.net", paired: false },
      ],
      status: { profileId: "server", phase: "pairing_required", epoch: 0, message: "Enter a pairing code." },
      secureStorageAvailable: true,
      canManage: false,
      pairingLink: { deviceName: "Safari on iPhone" },
    };
    const { api } = bridge(web);
    render(
      <ConnectionGate>
        <App onMount={() => undefined} />
      </ConnectionGate>,
    );
    const name = await screen.findByRole("textbox", { name: "Device name" });
    expect(name).toHaveValue("Safari on iPhone");
    expect(screen.queryByRole("textbox", { name: "Pairing code" })).toBeNull();
    await userEvent.clear(name);
    await userEvent.type(name, "Ana's phone ");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(api.activateConnection).toHaveBeenCalledWith({ id: "server", deviceName: "Ana's phone" });
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
    // The connections list is one click away, unchanged.
    await userEvent.click(await screen.findByRole("button", { name: "Manage connections" }));
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
