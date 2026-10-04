import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ShortcutSettingsSection } from "@/components/shortcut-settings-section";
import { DEFAULT_PREFERENCES, type AppPreferences } from "@/lib/app-preferences";

function renderSection(preferences: AppPreferences = DEFAULT_PREFERENCES) {
  const onPreferencesChange = vi.fn();
  render(<ShortcutSettingsSection active preferences={preferences} onPreferencesChange={onPreferencesChange} />);
  return onPreferencesChange;
}

describe("ShortcutSettingsSection", () => {
  it("records a new voice input shortcut", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSection();

    await user.click(screen.getByRole("button", { name: "Change shortcut for Start or stop voice input" }));
    await user.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");

    expect(onPreferencesChange).toHaveBeenCalledWith(
      expect.objectContaining({ shortcuts: { voiceInput: "Ctrl+Shift+KeyM" } }),
    );
  });

  it("refuses plain keys and shortcuts the app already uses", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSection();

    await user.click(screen.getByRole("button", { name: "Change shortcut for Start or stop voice input" }));
    await user.keyboard("m");
    expect(screen.getByRole("status")).toHaveTextContent("Use Ctrl, Alt, or Super together with another key");
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("status")).toHaveTextContent("Ctrl+K is already used for Search.");
    await user.keyboard("{Escape}");

    expect(screen.getByRole("status")).toHaveTextContent("Shortcut unchanged.");
    expect(onPreferencesChange).not.toHaveBeenCalled();
  });

  it("resets a custom shortcut to Ctrl+Space", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSection({ ...DEFAULT_PREFERENCES, shortcuts: { voiceInput: "Alt+KeyV" } });

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(onPreferencesChange).toHaveBeenCalledWith(
      expect.objectContaining({ shortcuts: { voiceInput: "Ctrl+Space" } }),
    );
  });
});
