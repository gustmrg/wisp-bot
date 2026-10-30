import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsGroup } from "@/components/settings/settings-primitives";
import { SettingsScopeNote } from "@/components/settings/settings-scope";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import type { ConnectionsView } from "../../../shared/connections";

function view(activeId: string): ConnectionsView {
  return {
    activeId,
    profiles: [
      { id: "local", kind: "local", name: "This computer", paired: true },
      { id: "home", kind: "url", name: "Home server", url: "https://test-host.invalid", paired: true },
    ],
    status: { profileId: activeId, phase: activeId === "local" ? "local" : "connected", epoch: 1 },
    secureStorageAvailable: true,
  };
}

describe("SettingsScopeNote", () => {
  it("says a device setting stays on this device, whatever the connection", () => {
    render(
      <ActiveConnectionContext.Provider value={view("home")}>
        <SettingsScopeNote scope="device" />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByText("Saved on this device.")).toBeVisible();
  });

  it("names the server an environment setting is saved on", () => {
    render(
      <ActiveConnectionContext.Provider value={view("home")}>
        <SettingsScopeNote scope="environment" />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByText("Saved on Home server, for every device connected to it.")).toBeVisible();
  });

  it("says an environment setting belongs to this computer when using it", () => {
    render(
      <ActiveConnectionContext.Provider value={view("local")}>
        <SettingsScopeNote scope="environment" />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByText("Saved for the Wisps on this computer.")).toBeVisible();
  });

  it("does not become part of its group's name", () => {
    render(
      <SettingsGroup label="Application" note={<SettingsScopeNote scope="device" />}>
        <p>Content</p>
      </SettingsGroup>,
    );
    expect(screen.getByRole("region", { name: "Application" })).toHaveTextContent("Saved on this device.");
  });
});
