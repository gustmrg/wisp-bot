import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsGroup } from "@/components/settings/settings-primitives";
import { SettingsPanelTitle, SettingsScopeNote } from "@/components/settings/settings-scope";
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
    expect(screen.getByText("This device")).toBeVisible();
    expect(screen.getByText("Saved on this device.")).toBeInTheDocument();
  });

  it("names the server an environment setting is saved on", () => {
    render(
      <ActiveConnectionContext.Provider value={view("home")}>
        <SettingsScopeNote scope="environment" />
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByText("Home server")).toBeVisible();
    expect(screen.getByText("Saved on Home server, for every device connected to it.")).toBeInTheDocument();
  });

  it.each(["device", "environment"] as const)("says nothing about a %s setting on this computer", (scope) => {
    const { container } = render(
      <ActiveConnectionContext.Provider value={view("local")}>
        <SettingsScopeNote scope={scope} />
      </ActiveConnectionContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("puts the note beside a panel's title without renaming it", () => {
    render(
      <ActiveConnectionContext.Provider value={view("home")}>
        <SettingsPanelTitle id="title" scope="environment">
          AI Model
        </SettingsPanelTitle>
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "AI Model" })).toBeVisible();
    expect(screen.getByText("Home server")).toBeVisible();
  });

  it("does not become part of its group's name", () => {
    render(
      <ActiveConnectionContext.Provider value={view("home")}>
        <SettingsGroup label="Application" note={<SettingsScopeNote scope="device" />}>
          <p>Content</p>
        </SettingsGroup>
      </ActiveConnectionContext.Provider>,
    );
    expect(screen.getByRole("region", { name: "Application" })).toHaveTextContent("This device");
  });
});
