import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "./connections-panel";

function setup(
  testSshConnection = vi.fn().mockResolvedValue({ ok: true, value: { message: "SSH connection successful." } }),
) {
  const api = { testSshConnection, saveConnection: vi.fn(), activateConnection: vi.fn() };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  render(
    <ConnectionsPanel
      view={{
        activeId: "local",
        profiles: [],
        status: { profileId: "local", phase: "local", epoch: 0 },
        secureStorageAvailable: true,
      }}
    />,
  );
  return api;
}

describe("SSH form test", () => {
  it("tests unsaved fields, clears stale feedback, and allows retry", async () => {
    const api = setup(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { message: "SSH authentication failed." } })
        .mockResolvedValue({ ok: true, value: { message: "SSH connection successful." } }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add a server/ }));
    await user.type(screen.getByLabelText("Host"), "example");
    await user.type(screen.getByLabelText("User (optional)"), "alice");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("authentication failed");
    expect(api.testSshConnection).toHaveBeenCalledWith({
      kind: "ssh",
      name: "example",
      host: "example",
      user: "alice",
      serverPort: 8787,
    });
    await user.type(screen.getByLabelText("SSH port (optional)"), "2222");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("successful");
    expect(api.saveConnection).not.toHaveBeenCalled();
    expect(api.activateConnection).not.toHaveBeenCalled();
  });
  it("does not show a late result after editing the tested fields", async () => {
    let finish!: (value: unknown) => void;
    setup(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add a server/ }));
    await user.type(screen.getByLabelText("Host"), "old");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("button", { name: "Testing connection…" })).toBeDisabled();
    await user.type(screen.getByLabelText("Host"), "-changed");
    await act(async () => finish({ ok: true, value: { message: "stale success" } }));
    expect(screen.queryByText("stale success")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });
});
