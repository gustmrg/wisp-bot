import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MobileSettingsProfile } from "@/components/mobile-settings-profile";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import type { ConnectionsView } from "../../shared/connections";

const currentUser = { displayName: "Ada Lovelace", givenName: "Ada", initials: "AL" };

function renderProfile(view: ConnectionsView | null) {
  const onOpenProfile = vi.fn();
  const onOpenConnection = vi.fn();
  render(
    <ActiveConnectionContext.Provider value={view}>
      <MobileSettingsProfile
        currentUser={currentUser}
        appVersion="1.2.0"
        onOpenProfile={onOpenProfile}
        onOpenConnection={onOpenConnection}
      />
    </ActiveConnectionContext.Provider>,
  );
  return { onOpenProfile, onOpenConnection };
}

describe("MobileSettingsProfile", () => {
  it("opens the profile and the connection from their rows", async () => {
    const user = userEvent.setup();
    const { onOpenProfile, onOpenConnection } = renderProfile(null);

    await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));
    expect(onOpenProfile).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "This computer, Running here" }));
    expect(onOpenConnection).toHaveBeenCalledOnce();
    expect(screen.queryByText("Your workspace")).not.toBeInTheDocument();
  });

  it("names the server and this browser while reconnecting", () => {
    renderProfile({
      activeId: "server",
      profiles: [
        { id: "server", kind: "url", name: "wisp.example.ts.net", url: "https://wisp.example.ts.net", paired: true },
      ],
      status: { profileId: "server", phase: "reconnecting", epoch: 1 },
      secureStorageAvailable: true,
      canManage: false,
      deviceName: "Safari on iPhone",
    });

    expect(screen.getByRole("button", { name: "wisp.example.ts.net, Reconnecting… · Safari on iPhone" })).toBeVisible();
    expect(screen.queryByText("Version differs")).not.toBeInTheDocument();
  });

  it("flags a server version that differs from the app", () => {
    renderProfile({
      activeId: "home",
      profiles: [{ id: "home", kind: "ssh", name: "home-server", host: "home", serverPort: 4317, paired: true }],
      status: { profileId: "home", phase: "connected", serverVersion: "1.1.0", epoch: 1 },
      secureStorageAvailable: true,
    });

    expect(
      screen.getByRole("button", { name: "home-server, Connected, server version differs from this app" }),
    ).toBeVisible();
  });
});
