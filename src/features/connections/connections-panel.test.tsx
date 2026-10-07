import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionsView, SshConfigHost } from "../../../shared/connections";
import { ConnectionsPanel } from "./connections-panel";

const view: ConnectionsView = {
  activeId: "local",
  profiles: [
    { id: "local", kind: "local", name: "This computer", paired: true },
    { id: "nas", kind: "ssh", name: "NAS", host: "nas", serverPort: 8787, paired: true },
  ],
  status: { profileId: "local", phase: "local", epoch: 1 },
  secureStorageAvailable: true,
};

function bridge(hosts: SshConfigHost[]) {
  const api = {
    listSshHosts: vi.fn(async () => ({ ok: true as const, value: hosts })),
    saveConnection: vi.fn(async () => ({ ok: true as const, value: view })),
    checkSshServer: vi.fn(async () => ({ ok: true as const, value: { appVersion: "1.0.0", addedKey: false } })),
    cancelSshCheck: vi.fn(async () => ({ ok: true as const, value: view })),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

describe("ConnectionsPanel", () => {
  it("adds a server chosen from the SSH config by its alias", async () => {
    const api = bridge([
      { alias: "pi", hostname: "192.168.1.20", user: "me", port: 22 },
      { alias: "work", hostname: "work.test.invalid", user: "me", port: 2222 },
      { alias: "nas", hostname: "nas.test.invalid" },
    ]);
    render(<ConnectionsPanel view={view} />);
    await userEvent.click(screen.getByRole("button", { name: /Add a server/ }));

    const list = await screen.findByRole("list", { name: "From your SSH config" });
    expect(list).toHaveTextContent("me@192.168.1.20");
    expect(list).toHaveTextContent("me@work.test.invalid:2222");
    // A host that already has a connection cannot be added twice from here.
    expect(screen.getByRole("button", { name: /nas/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /^work/ }));
    expect(screen.getByRole("button", { name: /^work/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Home server")).toHaveValue("work");
    // Choosing another one also renames a name that was not typed.
    await userEvent.click(screen.getByRole("button", { name: /^pi/ }));
    expect(screen.getByPlaceholderText("Home server")).toHaveValue("pi");

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.saveConnection).toHaveBeenCalledWith({ kind: "ssh", name: "pi", host: "pi", serverPort: 8787 });
  });

  it("keeps a typed name, and shows no list without SSH config hosts", async () => {
    bridge([{ alias: "pi" }]);
    render(<ConnectionsPanel view={view} />);
    await userEvent.click(screen.getByRole("button", { name: /Add a server/ }));
    await userEvent.type(screen.getByPlaceholderText("Home server"), "Kitchen");
    await userEvent.click(await screen.findByRole("button", { name: "pi" }));
    expect(screen.getByPlaceholderText("Home server")).toHaveValue("Kitchen");

    bridge([]);
    await userEvent.click(screen.getByRole("radio", { name: "HTTPS address" }));
    await userEvent.click(screen.getByRole("radio", { name: "SSH" }));
    expect(screen.queryByRole("list", { name: "From your SSH config" })).toBeNull();
  });
});
