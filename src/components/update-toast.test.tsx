import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { UpdateState } from "../../shared/contracts";
import { UpdateToast } from "@/components/update-toast";

const updated: UpdateState = { phase: "idle", currentVersion: "0.26.0", updatedFrom: "0.25.2" };

function bridge(state: UpdateState) {
  let push: (next: UpdateState) => void = () => undefined;
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getUpdateState: vi.fn(async () => ({ ok: true as const, value: state })),
      subscribeToUpdateState: vi.fn((listener: (next: UpdateState) => void) => {
        push = listener;
        return () => undefined;
      }),
      openReleasesPage: vi.fn(async () => ({ ok: true as const, value: undefined })),
    },
  });
  return { push: (next: UpdateState) => act(() => push(next)) };
}

/** The toast with its two preferences kept in state, as the app keeps them in this device's storage. */
function Harness({ initial }: { initial: { announce: boolean; announcedVersion: string } }) {
  const [preferences, setPreferences] = useState(initial);
  return (
    <>
      <UpdateToast
        displayName="Wisp"
        announce={preferences.announce}
        announcedVersion={preferences.announcedVersion}
        onAnnounced={(announcedVersion) => setPreferences((current) => ({ ...current, announcedVersion }))}
        onSilence={() => setPreferences((current) => ({ ...current, announce: false }))}
      />
      <output data-testid="preferences">{JSON.stringify(preferences)}</output>
    </>
  );
}

describe("UpdateToast", () => {
  it("announces an update once and records the version it announced", async () => {
    bridge(updated);
    render(<Harness initial={{ announce: true, announcedVersion: "" }} />);

    expect(await screen.findByText("Wisp updated to 0.26.0")).toBeVisible();
    expect(screen.getByText("Previously 0.25.2.")).toBeVisible();
    expect(screen.getByTestId("preferences")).toHaveTextContent('"announcedVersion":"0.26.0"');
  });

  it("says nothing on a later opening of the same version", async () => {
    bridge(updated);
    render(<Harness initial={{ announce: true, announcedVersion: "0.26.0" }} />);

    await act(async () => undefined);
    expect(screen.queryByText(/updated to/)).toBeNull();
  });

  it("stops announcing updates on this device with Don't show again", async () => {
    bridge(updated);
    render(<Harness initial={{ announce: true, announcedVersion: "" }} />);

    await userEvent.click(await screen.findByRole("button", { name: "Don't show again" }));
    expect(screen.queryByText(/updated to/)).toBeNull();
    expect(screen.getByTestId("preferences")).toHaveTextContent('"announce":false');
  });

  it("still shows an install in progress with announcements off", async () => {
    const { push } = bridge(updated);
    render(<Harness initial={{ announce: false, announcedVersion: "" }} />);

    await act(async () => undefined);
    expect(screen.queryByText(/updated to/)).toBeNull();
    await push({ phase: "installing", currentVersion: "0.26.0", availableVersion: "0.27.0" });
    expect(screen.getByText("Installing version 0.27.0…")).toBeVisible();
  });
});
