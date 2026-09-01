import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chat } from "@/chat-data";
import { DetailsPanel } from "@/components/details-panel";

const chat: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "Finds relevant information",
  shape: "circle",
  isCircle: false,
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

function renderDetails(): void {
  render(
    <DetailsPanel
      chat={chat}
      chats={{ atlas: chat }}
      width={318}
      onChange={vi.fn()}
      onClose={vi.fn()}
      onDelete={vi.fn()}
      onResizeStart={vi.fn()}
    />,
  );
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe("DetailsPanel template sharing", () => {
  afterEach(() => setClipboard(undefined));

  it("announces clipboard success only after the write resolves", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    setClipboard(writeText);
    renderDetails();

    await user.click(screen.getByRole("button", { name: "Share as template" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Template link copied");
    expect(screen.getByRole("button", { name: "Template link copied" })).toBeVisible();
    expect(writeText).toHaveBeenCalledWith("wisp://template/atlas");
  });

  it("announces clipboard failures", async () => {
    const user = userEvent.setup();
    setClipboard(async () => {
      throw new Error("denied");
    });
    renderDetails();

    await user.click(screen.getByRole("button", { name: "Share as template" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy template link");
    expect(screen.getByRole("button", { name: "Could not copy template link" })).toBeVisible();
  });
});
