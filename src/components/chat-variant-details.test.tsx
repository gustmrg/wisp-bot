import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CircleChat, WispChat } from "@/chat-data";
import { CircleDetails } from "@/components/circle-details";
import { WispDetails } from "@/components/wisp-details";

const wisp: WispChat = {
  id: "atlas",
  kind: "wisp",
  name: "Atlas",
  label: "Research",
  description: "Researches",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

const circle: CircleChat = {
  id: "crew",
  kind: "circle",
  name: "Crew",
  label: "Circle",
  description: "Works together",
  memberIds: [wisp.id],
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

describe("variant details", () => {
  it("renders Wisp-only appearance editing", () => {
    render(<WispDetails chat={wisp} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Wisp shape" })).toBeVisible();
    expect(screen.getByText("Identity & personality")).toBeVisible();
    expect(screen.getByDisplayValue("Researches")).toHaveAttribute("maxlength", "4000");
    expect(screen.getByDisplayValue("Researches")).toHaveAttribute("rows", "5");
  });

  it("renders circle-only membership details", () => {
    render(<CircleDetails chat={circle} chats={{ atlas: wisp, crew: circle }} onChange={vi.fn()} />);
    expect(screen.getByText("Participants (1)")).toBeVisible();
    expect(screen.getAllByText("Atlas")).not.toHaveLength(0);
    expect(screen.getByRole("group", { name: "Edit participants" })).toBeVisible();
  });
});
