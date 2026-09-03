import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ChatCollection } from "@/chat-data";
import { SearchDialog } from "@/components/search-dialog";

const chats: ChatCollection = {
  atlas: {
    id: "atlas",
    name: "Atlas",
    label: "Research",
    description: "Finds relevant information",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Latest research",
    timestamp: "Now",
    messages: [
      { id: "incoming", type: "incoming", text: "The launch checklist is ready." },
      { id: "outgoing", type: "outgoing", text: "Review the quarterly roadmap." },
    ],
  },
  pixel: {
    id: "pixel",
    name: "Pixel",
    label: "Design",
    description: "Creates interfaces",
    kind: "wisp",
    shape: "square",
    notifyOnUpdatesEnabled: true,
    preview: "Designing",
    timestamp: "Now",
    messages: [],
  },
};

describe("SearchDialog", () => {
  it.each([
    ["launch checklist", "The launch checklist is ready."],
    ["quarterly roadmap", "Review the quarterly roadmap."],
  ])("finds ordinary message text for %s", async (query, snippet) => {
    const user = userEvent.setup();
    render(<SearchDialog chats={chats} open onOpenChange={vi.fn()} onSelectChat={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Messages" }));
    await user.type(screen.getByRole("textbox", { name: "Search" }), query);

    expect(await screen.findByText(snippet)).toBeVisible();
    expect(screen.queryByText("Pixel")).not.toBeInTheDocument();
  });
});
