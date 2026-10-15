import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NotificationSettingsSection } from "@/components/notification-settings-section";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }));
vi.mock("@/lib/notification-sounds", () => ({ playNotificationSound }));

function Settings() {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  return (
    <NotificationSettingsSection
      preferences={preferences}
      onPreferencesChange={setPreferences}
      persistenceStatus="saved"
      persistenceError={null}
    />
  );
}

it("updates volume, previews each sound, and preserves event choices when muted", async () => {
  const user = userEvent.setup();
  render(<Settings />);
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "40" } });
  for (const [label, kind] of [
    ["Response completed", "finished"],
    ["Approval needed", "needs-input"],
    ["Execution error", "error"],
  ]) {
    await user.click(screen.getByRole("button", { name: `Test sound: ${label}` }));
    expect(playNotificationSound).toHaveBeenLastCalledWith(kind, 40);
    await user.click(screen.getByRole("switch", { name: `Sound: ${label}` }));
    expect(screen.getByRole("switch", { name: `Sound: ${label}` })).not.toBeChecked();
  }
  await user.click(screen.getByRole("switch", { name: "Mute the open conversation" }));
  expect(screen.getByRole("switch", { name: "Mute the open conversation" })).toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test sound: Response completed" })).toBeDisabled();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toHaveValue("40");
  expect(screen.getByRole("switch", { name: "Sound: Response completed" })).not.toBeChecked();
});

it("shows persistence errors", () => {
  render(
    <NotificationSettingsSection
      preferences={DEFAULT_PREFERENCES}
      onPreferencesChange={vi.fn()}
      persistenceStatus="saved"
      persistenceError="Could not save preferences."
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save preferences.");
});

it("controls system notifications apart from sounds, with a test for each event, in the desktop app", async () => {
  const user = userEvent.setup();
  const test = vi.fn(async () => ({ ok: true as const, value: {} }));
  Object.defineProperty(window, "wisp", { configurable: true, value: { systemNotifications: { test } } });
  try {
    render(<Settings />);
    await user.click(screen.getByRole("button", { name: "Test notification: Approval needed" }));
    expect(test).toHaveBeenCalledWith({ kind: "needs-input" });
    await user.click(screen.getByRole("switch", { name: "Notification: Execution error" }));
    expect(screen.getByRole("switch", { name: "Notification: Execution error" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Sound: Execution error" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "System notifications" }));
    expect(screen.getByRole("button", { name: "Test notification: Approval needed" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Notification: Response completed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test sound: Approval needed" })).toBeEnabled();
  } finally {
    Reflect.deleteProperty(window, "wisp");
  }
});

it("offers no system notifications in the browser app", () => {
  render(<Settings />);
  expect(screen.queryByRole("switch", { name: "System notifications" })).toBeNull();
});
