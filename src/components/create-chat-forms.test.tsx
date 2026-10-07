import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateWispForm } from "@/components/create-wisp-form";
import type { WispSettingsDraft } from "@/components/wisp-settings-fields";

const wisp: WispSettingsDraft = { name: "", role: "", soul: "", shape: "hexagon", notifyOnUpdatesEnabled: true };

describe("create chat forms", () => {
  it("renders the Wisp-only appearance fields", () => {
    render(<CreateWispForm settings={wisp} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Wisp color" })).toBeVisible();
  });
});
