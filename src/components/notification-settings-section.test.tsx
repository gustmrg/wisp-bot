import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NotificationSettingsSection } from "@/components/notification-settings-section";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }));
vi.mock("@/lib/notification-sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notification-sounds")>()),
  playNotificationSound,
}));

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
    expect(playNotificationSound).toHaveBeenLastCalledWith(kind, 40, "chime");
    await user.click(screen.getByRole("combobox", { name: `Sound: ${label}` }));
    await user.click(await screen.findByRole("option", { name: "None" }));
    expect(screen.getByRole("combobox", { name: `Sound: ${label}` })).toHaveTextContent("None");
    expect(screen.getByRole("button", { name: `Test sound: ${label}` })).toBeDisabled();
  }
  await user.click(screen.getByRole("switch", { name: "Mute the open conversation" }));
  expect(screen.getByRole("switch", { name: "Mute the open conversation" })).toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Test sound: Response completed" })).toBeDisabled();
  await user.click(screen.getByRole("switch", { name: "Notification sounds" }));
  expect(screen.getByRole("slider")).toHaveValue("40");
  expect(screen.getByRole("combobox", { name: "Sound: Response completed" })).toHaveTextContent("None");
});

it("plays a sound as soon as it is chosen, and keeps it for that event only", async () => {
  const user = userEvent.setup();
  playNotificationSound.mockClear();
  render(<Settings />);
  const select = screen.getByRole("combobox", { name: "Sound: Approval needed" });
  expect(select).toHaveTextContent("Chime");
  await user.click(select);
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
    "None",
    "Chime",
    "Marimba",
    "Bell",
    "Glass",
    "Pop",
    "Soft",
  ]);
  await user.click(screen.getByRole("option", { name: "Bell" }));
  expect(playNotificationSound).toHaveBeenCalledExactlyOnceWith("needs-input", 100, "bell");
  expect(select).toHaveTextContent("Bell");
  expect(screen.getByRole("combobox", { name: "Sound: Response completed" })).toHaveTextContent("Chime");

  await user.click(screen.getByRole("button", { name: "Test sound: Approval needed" }));
  expect(playNotificationSound).toHaveBeenLastCalledWith("needs-input", 100, "bell");

  // Choosing None plays nothing; choosing a sound again turns the event back on with it.
  await user.click(select);
  await user.click(await screen.findByRole("option", { name: "None" }));
  expect(playNotificationSound).toHaveBeenCalledTimes(2);
  await user.click(select);
  await user.click(await screen.findByRole("option", { name: "Bell" }));
  expect(select).toHaveTextContent("Bell");
  expect(screen.getByRole("button", { name: "Test sound: Approval needed" })).toBeEnabled();
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
    expect(screen.getByRole("combobox", { name: "Sound: Execution error" })).toHaveTextContent("Chime");
    await user.click(screen.getByRole("switch", { name: "System notifications" }));
    expect(screen.getByRole("button", { name: "Test notification: Approval needed" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Notification: Response completed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test sound: Approval needed" })).toBeEnabled();
  } finally {
    Reflect.deleteProperty(window, "wisp");
  }
});

it("lists system notifications first, in Channels and in each event's columns", () => {
  Object.defineProperty(window, "wisp", { configurable: true, value: { systemNotifications: { test: vi.fn() } } });
  try {
    render(<Settings />);
    const channels = within(screen.getByRole("region", { name: "Channels" }));
    expect(channels.getAllByRole("switch").map((control) => control.getAttribute("aria-label"))).toEqual([
      "System notifications",
      "Notification sounds",
    ]);
    const system = screen.getByRole("switch", { name: "Notification: Execution error" });
    const sound = screen.getByRole("combobox", { name: "Sound: Execution error" });
    expect(system.compareDocumentPosition(sound) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally {
    Reflect.deleteProperty(window, "wisp");
  }
});

it("offers no system notifications in the browser app", () => {
  render(<Settings />);
  expect(screen.queryByRole("switch", { name: "System notifications" })).toBeNull();
});

it("brings the server connection notice back after Don't show again", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem("wisp-bot-connection-notices-off", "1");
  render(<Settings />);
  const notice = screen.getByRole("switch", { name: "Server connection notice" });
  expect(notice).not.toBeChecked();

  await user.click(notice);
  expect(notice).toBeChecked();
  expect(window.localStorage.getItem("wisp-bot-connection-notices-off")).toBeNull();
  await user.click(notice);
  expect(window.localStorage.getItem("wisp-bot-connection-notices-off")).toBe("1");
  window.localStorage.clear();
});
