import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GeneralSettingsSections } from "@/components/general-settings-sections";
import { DEFAULT_PREFERENCES, type AppPreferences } from "@/lib/app-preferences";

function renderSections(preferences: AppPreferences) {
  const onPreferencesChange = vi.fn();
  render(<GeneralSettingsSections preferences={preferences} onPreferencesChange={onPreferencesChange} />);
  return onPreferencesChange;
}

describe("GeneralSettingsSections time format", () => {
  it("follows the system by default and stores a fixed 24-hour or 12-hour choice", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSections(DEFAULT_PREFERENCES);
    const format = within(screen.getByRole("radiogroup", { name: "Time format" }));
    expect(format.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(screen.getByText(/Follows your system's language/)).toBeVisible();

    await user.click(format.getByRole("radio", { name: "12-hour" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ timeFormat: "12h" }));
  });

  it("no longer holds the Wisps' permissions, which have their own section", () => {
    renderSections(DEFAULT_PREFERENCES);
    expect(screen.getByRole("region", { name: "Date and time" })).toBeVisible();
    expect(screen.queryByText("Auto-review file changes")).toBeNull();
  });

  it("shows how times read with a fixed format", () => {
    renderSections({ ...DEFAULT_PREFERENCES, timeFormat: "24h" });
    expect(screen.getByText("Times read like 21:05.")).toBeVisible();
  });
});
