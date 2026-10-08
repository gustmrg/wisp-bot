import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateWispForm } from "@/components/create-wisp-form";
import type { WispSettingsDraft } from "@/components/wisp-settings-fields";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";

const wisp: WispSettingsDraft = {
  name: "",
  role: "",
  soul: "",
  appearance: DEFAULT_WISP_APPEARANCE,
  notifyOnUpdatesEnabled: true,
};

describe("create chat forms", () => {
  it("renders the Wisp-only appearance fields", () => {
    render(<CreateWispForm settings={wisp} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Wisp color" })).toBeVisible();
  });

  it("keeps the finer appearance choices behind More options", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CreateWispForm settings={wisp} onChange={onChange} />);
    for (const axis of ["Wisp trail", "Wisp body", "Wisp eyes"]) {
      expect(screen.getByRole("group", { name: axis })).toBeVisible();
    }
    expect(screen.queryByRole("radiogroup", { name: "Wisp finish" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(screen.getByRole("radio", { name: "Outline" }));
    expect(onChange).toHaveBeenLastCalledWith({
      appearance: { ...DEFAULT_WISP_APPEARANCE, finish: "line" },
      avatarImage: undefined,
    });
  });
});
