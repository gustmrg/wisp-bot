import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionsView } from "../../shared/connections";
import { ConnectionSettingsSection } from "./connection-settings-section";

describe("ConnectionSettingsSection in the browser app", () => {
  it("signs this browser out of its server", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Sign out of this browser" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(api.removeConnection).toHaveBeenCalledWith({ id: "server" });
  });
});
