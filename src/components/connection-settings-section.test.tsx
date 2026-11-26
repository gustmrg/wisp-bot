import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionsView } from "../../shared/connections";
import { ConnectionSettingsSection } from "./connection-settings-section";

describe("ConnectionSettingsSection in the browser app", () => {
  it("signs this browser out of its server and hides background toggle", async () => {
    const view: ConnectionsView = {
      activeId: "server",
      profiles: [
        { id: "server", kind: "url", name: "wisp.example.ts.net", url: "https://wisp.example.ts.net", paired: true },
      ],
      status: { profileId: "server", phase: "connected", epoch: 1 },
      secureStorageAvailable: true,
      canManage: false,
    };
    const api = {
      getConnections: vi.fn(async () => ({ ok: true, value: view })),
      subscribeToConnections: vi.fn(() => () => undefined),
      removeConnection: vi.fn(async () => ({ ok: true, value: view })),
    };
    Object.defineProperty(window, "wisp", { configurable: true, value: api });
    render(<ConnectionSettingsSection />);
    expect(await screen.findByText(/This browser uses the Wisps on wisp.example.ts.net/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Add a server/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Keep this computer's Wisps running/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out of this browser" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(api.removeConnection).toHaveBeenCalledWith({ id: "server" });
  });
});

describe("ConnectionSettingsSection background setting", () => {
  it("hides the keepLocalRunning toggle when only one environment exists", async () => {
    const view: ConnectionsView = {
      activeId: "local",
      profiles: [{ id: "local", kind: "local", name: "This computer", paired: true }],
      status: { profileId: "local", phase: "local", epoch: 1 },
      secureStorageAvailable: true,
      keepLocalRunning: true,
    };
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getConnections: vi.fn(async () => ({ ok: true, value: view })),
        subscribeToConnections: vi.fn(() => () => undefined),
      },
    });
    render(<ConnectionSettingsSection />);
    expect(await screen.findByText("This computer")).toBeVisible();
    expect(screen.queryByRole("switch", { name: /Keep this computer's Wisps running/ })).not.toBeInTheDocument();
  });

  it("toggles keepLocalRunning when two or more environments exist", async () => {
    const user = userEvent.setup();
    let listener: ((next: ConnectionsView) => void) | undefined;
    const view: ConnectionsView = {
      activeId: "local",
      profiles: [
        { id: "local", kind: "local", name: "This computer", paired: true },
        { id: "home", kind: "url", name: "Home server", url: "https://test-host.invalid", paired: true },
      ],
      status: { profileId: "local", phase: "local", epoch: 1 },
      secureStorageAvailable: true,
      keepLocalRunning: true,
    };
    const setKeepLocalRunning = vi.fn(async ({ enabled }: { enabled: boolean }) => {
      const next = { ...view, keepLocalRunning: enabled };
      listener?.(next);
      return { ok: true, value: next };
    });
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: {
        getConnections: vi.fn(async () => ({ ok: true, value: view })),
        subscribeToConnections: vi.fn((fn: (next: ConnectionsView) => void) => {
          listener = fn;
          return () => undefined;
        }),
        setKeepLocalRunning,
      },
    });

    render(<ConnectionSettingsSection />);
    const toggle = await screen.findByRole("switch", {
      name: "Keep this computer's Wisps running in the background",
    });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(setKeepLocalRunning).toHaveBeenCalledWith({ enabled: false });
    expect(toggle).not.toBeChecked();
  });
});
