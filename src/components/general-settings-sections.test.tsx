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

describe("GeneralSettingsSections auto-review", () => {
  it("shows the effective behavior per file category and splits a shared rule when one changes", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSections({
      ...DEFAULT_PREFERENCES,
      autoReviewRules: [
        { id: "all", action: "all_file_changes", behavior: "allow", scope: "workspace" },
        { id: "mcp", action: "integration_call", behavior: "block", scope: "integration" },
      ],
    });
    const create = within(screen.getByRole("radiogroup", { name: "When Wisp wants to create files" }));
    const modify = within(screen.getByRole("radiogroup", { name: "When Wisp wants to modify files" }));
    expect(create.getByRole("radio", { name: "Allow" })).toBeChecked();
    expect(modify.getByRole("radio", { name: "Allow" })).toBeChecked();

    await user.click(create.getByRole("radio", { name: "Block" }));
    const rules = onPreferencesChange.mock.calls[0]?.[0].autoReviewRules;
    expect(rules).toEqual([
      { id: "mcp", action: "integration_call", behavior: "block", scope: "integration" },
      expect.objectContaining({ action: "create_file", behavior: "block", scope: "workspace" }),
      expect.objectContaining({ action: "modify_file", behavior: "allow", scope: "workspace" }),
    ]);
    expect(screen.getByRole("list", { name: "Integration blocks" })).toHaveTextContent("MCP tool calls");
  });

  it("stores no rule for Ask, the default", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = renderSections({
      ...DEFAULT_PREFERENCES,
      autoReviewRules: [{ id: "create", action: "create_file", behavior: "block", scope: "workspace" }],
    });
    const create = within(screen.getByRole("radiogroup", { name: "When Wisp wants to create files" }));
    await user.click(create.getByRole("radio", { name: "Ask" }));
    expect(onPreferencesChange.mock.calls[0]?.[0].autoReviewRules).toEqual([]);
  });

  it("disables the rules while auto-review is off and marks unavailable settings", () => {
    renderSections({ ...DEFAULT_PREFERENCES, autoReview: false });
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByText(/Wisp asks before every file change/)).toBeVisible();
    expect(screen.getAllByText("Soon")).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Use hardware acceleration" })).toBeDisabled();
  });
});
