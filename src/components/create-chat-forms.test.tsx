import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WispChat } from "@/chat-data";
import { CreateWispForm } from "@/components/create-wisp-form";

const wisp: WispChat = {
  id: "new-wisp",
  kind: "wisp",
  name: "",
  label: "",
  description: "",
  shape: "hexagon",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "",
  messages: [],
};

describe("create chat forms", () => {
  it("renders the Wisp-only appearance fields", () => {
    render(<CreateWispForm settings={wisp} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Wisp color" })).toBeVisible();
  });
});
