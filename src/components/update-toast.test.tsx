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

/** The toast with the announced version kept in state, as the app keeps it in this device's storage. */
function Harness({ announcedVersion: initial }: { announcedVersion: string }) {
  const [announcedVersion, setAnnouncedVersion] = useState(initial);
  return (
    <>
      <UpdateToast displayName="Wisp" announcedVersion={announcedVersion} onAnnounced={setAnnouncedVersion} />
      <output data-testid="announced">{announcedVersion}</output>
    </>
  );
}

describe("UpdateToast", () => {
  it("announces an update once and records the version it announced", async () => {
    bridge(updated);
    render(<Harness announcedVersion="" />);

    expect(await screen.findByText("Wisp updated to 0.26.0")).toBeVisible();
    expect(screen.getByText("Previously 0.25.2.")).toBeVisible();
    expect(screen.getByTestId("announced")).toHaveTextContent("0.26.0");
    // Recording the version does not hide the toast that is showing.
    expect(screen.getByText("Wisp updated to 0.26.0")).toBeVisible();
  });

  it("says nothing when the window reopens or reloads after announcing the version", async () => {
    // The main process still reports the update until it quits.
    bridge(updated);
    render(<Harness announcedVersion="0.26.0" />);

    await act(async () => undefined);
    expect(screen.queryByText(/updated to/)).toBeNull();
  });

  it("announces the next version once more", async () => {
    bridge({ phase: "idle", currentVersion: "0.27.0", updatedFrom: "0.26.0" });
    render(<Harness announcedVersion="0.26.0" />);

    expect(await screen.findByText("Wisp updated to 0.27.0")).toBeVisible();
  });

  it("offers no way to turn the announcement off", async () => {
    bridge(updated);
    render(<Harness announcedVersion="" />);

    await screen.findByText("Wisp updated to 0.26.0");
    expect(screen.queryByRole("button", { name: "Don't show again" })).toBeNull();
    expect(screen.getByRole("button", { name: "See what's new" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/updated to/)).toBeNull();
  });

  it("shows an install in progress", async () => {
    const { push } = bridge({ phase: "idle", currentVersion: "0.26.0" });
    render(<Harness announcedVersion="" />);

    await act(async () => undefined);
    await push({ phase: "installing", currentVersion: "0.26.0", availableVersion: "0.27.0" });
    expect(screen.getByText("Installing version 0.27.0…")).toBeVisible();
  });
});
