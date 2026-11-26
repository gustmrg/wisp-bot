import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  environmentPhase,
  isEnvironmentConnected,
  SettingsEnvironmentContext,
  SettingsEnvironmentSelector,
  type SettingsEnvironmentContextValue,
} from "@/components/settings/settings-environment-selector";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import type { ConnectionsView } from "../../../shared/connections";

function makeView(overrides: Partial<ConnectionsView> = {}): ConnectionsView {
  const activeId = overrides.activeId ?? "local";
  return {
    activeId,
    profiles: [
      { id: "local", kind: "local", name: "This computer", paired: true },
      { id: "home", kind: "url", name: "Home server", url: "https://test-host.invalid", paired: true },
    ],
    status: { profileId: activeId, phase: activeId === "local" ? "local" : "connected", epoch: 1 },
    secureStorageAvailable: true,
    environments: {
      local: {
        profileId: "local",
        phase: "local",
        workingWisps: 0,
        pendingApprovals: 0,
        unreadConversations: 0,
        wispCount: 1,
        circleCount: 0,
      },
      home: {
        profileId: "home",
        phase: "connected",
        workingWisps: 0,
        pendingApprovals: 0,
        unreadConversations: 0,
        wispCount: 2,
        circleCount: 0,
      },
    },
    ...overrides,
  };
}

function makeContext(
  view: ConnectionsView,
  selectedEnvironmentId = view.activeId,
  onSelectEnvironment = vi.fn(),
): SettingsEnvironmentContextValue {
  const selectedPhase = environmentPhase(view, selectedEnvironmentId);
  return {
    connectionsView: view,
    selectedEnvironmentId,
    activeEnvironmentId: view.activeId,
    selectedProfile: view.profiles.find(({ id }) => id === selectedEnvironmentId),
    selectedPhase,
    isSelectedConnected: isEnvironmentConnected(selectedPhase),
    isActiveEnvironment: selectedEnvironmentId === view.activeId,
    onSelectEnvironment,
    onOpenConnections: vi.fn(),
  };
}

describe("SettingsPanelTitle and SettingsEnvironmentSelector", () => {
  it("renders a clean heading without a selector for device-scoped panels", () => {
    const view = makeView({ activeId: "home" });
    render(
      <SettingsEnvironmentContext.Provider value={makeContext(view)}>
        <SettingsPanelTitle id="title" scope="device">
          Notifications
        </SettingsPanelTitle>
      </SettingsEnvironmentContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();
    expect(screen.queryByText("This device")).not.toBeInTheDocument();
  });

  it("hides the environment selector when only one environment exists or in the browser app", () => {
    const singleProfile = makeView({
      profiles: [{ id: "local", kind: "local", name: "This computer", paired: true }],
    });
    const { rerender } = render(
      <SettingsEnvironmentContext.Provider value={makeContext(singleProfile)}>
        <SettingsPanelTitle id="title" scope="environment">
          AI Model
        </SettingsPanelTitle>
      </SettingsEnvironmentContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "AI Model" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();

    const browserView = makeView({ canManage: false });
    rerender(
      <SettingsEnvironmentContext.Provider value={makeContext(browserView)}>
        <SettingsPanelTitle id="title" scope="environment">
          AI Model
        </SettingsPanelTitle>
      </SettingsEnvironmentContext.Provider>,
    );
    expect(screen.queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument();
  });

  it("switches the inspected environment without renaming the heading or calling activateConnection", async () => {
    const user = userEvent.setup();
    const activateConnection = vi.fn();
    Object.defineProperty(window, "wisp", { configurable: true, value: { activateConnection } });
    const onSelectEnvironment = vi.fn();
    const view = makeView({ activeId: "local" });
    render(
      <SettingsEnvironmentContext.Provider value={makeContext(view, "local", onSelectEnvironment)}>
        <SettingsPanelTitle id="title" scope="environment">
          AI Model
        </SettingsPanelTitle>
      </SettingsEnvironmentContext.Provider>,
    );

    expect(screen.getByRole("heading", { name: "AI Model" })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector).toHaveTextContent("This computer");

    await user.click(selector);
    await user.click(await screen.findByRole("option", { name: /Home server/ }));

    expect(onSelectEnvironment).toHaveBeenCalledWith("home");
    expect(activateConnection).not.toHaveBeenCalled();
  });

  it("shows offline status labels inside the selector menu for disconnected profiles", async () => {
    const user = userEvent.setup();
    const view = makeView({
      profiles: [
        { id: "local", kind: "local", name: "This computer", paired: true },
        { id: "home", kind: "url", name: "Home server", url: "https://test-host.invalid", paired: false },
      ],
      environments: {
        local: {
          profileId: "local",
          phase: "local",
          workingWisps: 0,
          pendingApprovals: 0,
          unreadConversations: 0,
          wispCount: 1,
          circleCount: 0,
        },
        home: {
          profileId: "home",
          phase: "pairing_required",
          workingWisps: 0,
          pendingApprovals: 0,
          unreadConversations: 0,
          wispCount: 0,
          circleCount: 0,
        },
      },
    });
    render(
      <SettingsEnvironmentContext.Provider value={makeContext(view)}>
        <SettingsEnvironmentSelector />
      </SettingsEnvironmentContext.Provider>,
    );

    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    expect(await screen.findByRole("option", { name: /Home server.*Not paired yet/ })).toBeVisible();
  });
});
