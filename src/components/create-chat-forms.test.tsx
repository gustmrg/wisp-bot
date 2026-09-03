import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WispChat } from "@/chat-data";
import { CreateCircleForm } from "@/components/create-circle-form";
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

  it("renders the circle-only membership fields", () => {
    render(
      <CreateCircleForm
        name="Crew"
        availableWisps={[{ ...wisp, id: "atlas", name: "Atlas" }]}
        memberIds={[]}
        onNameChange={vi.fn()}
        onMemberIdsChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Add Wisps" })).toBeVisible();
    expect(screen.getByText("Atlas")).toBeVisible();
  });
});
