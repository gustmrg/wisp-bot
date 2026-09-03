import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SettingsCard,
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

describe("settings primitives", () => {
  it("labels groups and associates fields with their controls", () => {
    render(
      <SettingsGroup label="Profile">
        <SettingsCard>
          <SettingsField label="Display name" htmlFor="display-name">
            <input id="display-name" />
          </SettingsField>
        </SettingsCard>
      </SettingsGroup>,
    );

    expect(screen.getByRole("region", { name: "Profile" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Display name" })).toBeVisible();
  });

  it("supports accessible switches, row actions, and destructive actions", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    render(
      <SettingsCard variant="stacked">
        <SettingsRow>
          <SettingsRowCopy>
            <strong>Notifications</strong>
          </SettingsRowCopy>
          <ToggleSwitch label="Notifications" checked={false} onChange={onToggle} />
        </SettingsRow>
        <SettingsRow>
          <SettingsRowCopy>
            <strong>Danger zone</strong>
          </SettingsRowCopy>
          <Button variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        </SettingsRow>
      </SettingsCard>,
    );

    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("text-destructive");
  });
});
