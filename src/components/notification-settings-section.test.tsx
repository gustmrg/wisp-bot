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
    await user.click(screen.getByRole("switch", { name: label }));
    expect(screen.getByRole("switch", { name: label })).not.toBeChecked();
  }
  await user.click(screen.getByRole("switch", { name: "Mute the open conversation" }));
  expect(screen.getByRole("switch", { name: "Mute the open conversation" })).toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test sound: Response completed" })).toBeDisabled();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toHaveValue("40");
  expect(screen.getByRole("switch", { name: "Response completed" })).not.toBeChecked();
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
