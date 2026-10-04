import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LaunchAtLoginSetting } from "./launch-at-login-setting";

function bridge(enabled = false, supported = true) {
  const api = {
    getLaunchAtLoginState: vi.fn(async () => ({
      ok: true,
      value: { supported, enabled, reason: supported ? undefined : "Available only on Linux." },
    })),
    setLaunchAtLogin: vi.fn(async (next: boolean) => ({ ok: true, value: { supported, enabled: next } })),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

describe("LaunchAtLoginSetting", () => {
  it("loads registration and changes through IPC", async () => {
    const api = bridge(true);
    render(<LaunchAtLoginSetting open />);
    const toggle = screen.getByRole("switch", { name: "Launch at login" });
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);
    expect(api.setLaunchAtLogin).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
  it("disables unsupported platforms with an explanation", async () => {
    bridge(false, false);
    render(<LaunchAtLoginSetting open />);
    expect(await screen.findByText("Available only on Linux.")).toBeVisible();
    expect(screen.getByRole("switch")).toBeDisabled();
  });
  it("retains confirmed state when a change fails", async () => {
    const api = bridge();
    api.setLaunchAtLogin.mockRejectedValue(new Error("disk failure"));
    render(<LaunchAtLoginSetting open />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    await userEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change");
    expect(screen.getByRole("switch")).not.toBeChecked();
  });
  it("refreshes external changes on focus", async () => {
    const api = bridge();
    render(<LaunchAtLoginSetting open />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    api.getLaunchAtLoginState.mockResolvedValue({
      ok: true,
      value: { supported: true, enabled: true, reason: undefined },
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("switch")).toBeChecked();
  });
});
