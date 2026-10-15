import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RemoteAccessView } from "../../shared/remote-access";
import { RemoteAccessSettingsSection } from "./remote-access-settings-section";

const origin = "https://laptop.tailnet.ts.net";
const phone = {
  id: "phone",
  name: "Chrome on Android",
  createdAt: "2026-10-10T12:00:00.000Z",
  lastSeenAt: "2026-10-14T12:00:00.000Z",
};
const unset: RemoteAccessView = { enabled: false, port: 8787, webAppAvailable: true, devices: [] };
const on: RemoteAccessView = { enabled: true, port: 8787, publicOrigin: origin, webAppAvailable: true, devices: [] };
const off: RemoteAccessView = { ...on, enabled: false, devices: [] };

function expose(initial: RemoteAccessView) {
  const api = {
    getRemoteAccess: vi.fn(async () => ({ ok: true, value: initial })),
    saveRemoteAccess: vi.fn(async () => ({ ok: true, value: on }) as unknown),
    pairRemoteDevice: vi.fn(async () => ({
      ok: true,
      value: { code: "ABCDE-FGHJK", expiresAt: "2026-10-14T12:10:00.000Z", link: `${origin}/#pair=ABCDE-FGHJK` },
    })),
    revokeRemoteDevice: vi.fn(async () => ({ ok: true, value: on })),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

describe("RemoteAccessSettingsSection", () => {
  it("sets up remote access in steps, then shows a switch that is on", async () => {
    const api = expose(unset);
    render(<RemoteAccessSettingsSection />);
    expect(await screen.findByText("tailscale serve --bg http://127.0.0.1:8787")).toBeVisible();
    // No switch until there is an address to turn on.
    expect(screen.queryByRole("switch")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Turn on remote access" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the address Tailscale Serve shows");
    expect(api.saveRemoteAccess).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByRole("textbox", { name: "Port" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Port" }), "9000");
    expect(screen.getByText("tailscale serve --bg http://127.0.0.1:9000")).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: "HTTPS address" }), origin);
    await userEvent.click(screen.getByRole("button", { name: "Turn on remote access" }));
    expect(api.saveRemoteAccess).toHaveBeenCalledWith({ enabled: true, port: 9000, publicOrigin: origin });
    expect(await screen.findByRole("switch", { name: "Remote access" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Show QR code" })).toBeEnabled();
  });

  it("keeps the steps and shows why when the address does not reach this computer", async () => {
    const api = expose(unset);
    api.saveRemoteAccess.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "invalid_request",
        message: "Wisp could not reach https://laptop.tailnet.ts.net.",
        retryable: false,
      },
    });
    render(<RemoteAccessSettingsSection />);
    await userEvent.type(await screen.findByRole("textbox", { name: "HTTPS address" }), origin);
    await userEvent.click(screen.getByRole("button", { name: "Turn on remote access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wisp could not reach");
    expect(screen.getByRole("textbox", { name: "HTTPS address" })).toHaveValue(origin);
  });

  it("turns on and off with the switch once it has an address", async () => {
    const api = expose(off);
    render(<RemoteAccessSettingsSection />);
    const toggle = await screen.findByRole("switch", { name: "Remote access" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Show QR code" })).toBeDisabled();
    expect(screen.getByText("Turn on remote access to pair a device.")).toBeVisible();

    await userEvent.click(toggle);
    expect(api.saveRemoteAccess).toHaveBeenLastCalledWith({ enabled: true, port: 8787, publicOrigin: origin });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

    api.saveRemoteAccess.mockResolvedValueOnce({ ok: true, value: off });
    await userEvent.click(toggle);
    expect(api.saveRemoteAccess).toHaveBeenLastCalledWith({ enabled: false, port: 8787, publicOrigin: origin });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("shows a QR code, and closes it when the phone that scanned it is paired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = expose(on);
      render(<RemoteAccessSettingsSection />);
      await userEvent.click(await screen.findByRole("button", { name: "Show QR code" }));
      expect(screen.getByRole("img", { name: /QR code that pairs a device/ })).toBeVisible();
      expect(screen.getByText("ABCDE-FGHJK")).toBeVisible();
      expect(screen.getByText("No devices are paired yet.")).toBeVisible();

      api.getRemoteAccess.mockResolvedValue({ ok: true, value: { ...on, devices: [phone] } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText("Chrome on Android is paired with this computer.")).toBeVisible();
      expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
      expect(screen.getByText("Chrome on Android")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes a paired device", async () => {
    const api = expose({ ...on, devices: [phone] });
    render(<RemoteAccessSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke Chrome on Android" }));
    expect(api.revokeRemoteDevice).toHaveBeenCalledWith({ deviceId: "phone" });
    expect(await screen.findByText("No devices are paired yet.")).toBeVisible();
  });
});
