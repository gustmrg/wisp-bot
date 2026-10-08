import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatViewCollection } from "@/chat-data";
import { SearchDialog } from "@/components/search-dialog";
import type { WispApi } from "../../shared/contracts";
import type { MessageSearchHit } from "../../shared/conversations";
import { wispChatView } from "@/test/chat-fixtures";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";

const chats: ChatViewCollection = {
  atlas: wispChatView("atlas", {
    wisp: { name: "Atlas", role: "Research", soul: "Finds relevant information" },
    chat: { preview: "Latest research" },
  }),
  pixel: wispChatView("pixel", {
    wisp: { name: "Pixel", role: "Design", soul: "Creates interfaces", appearance: DEFAULT_WISP_APPEARANCE },
    chat: { preview: "Designing" },
  }),
};

const hits: MessageSearchHit[] = [
  { conversationId: "pixel", messageId: "newer", snippet: "The launch banner is ready." },
  { conversationId: "atlas", messageId: "older", snippet: "Review the launch checklist." },
  { conversationId: "deleted", messageId: "orphan", snippet: "A launch nobody can open." },
];

const searchMessages = vi.fn<WispApi["searchMessages"]>();

function renderDialog() {
  const handlers = { onOpenChange: vi.fn(), onSelectChat: vi.fn(), onSelectMessage: vi.fn() };
  render(<SearchDialog chats={chats} open {...handlers} />);
  return handlers;
}

describe("SearchDialog", () => {
  beforeEach(() => {
    searchMessages.mockResolvedValue({ ok: true, value: hits });
    (window as unknown as { wisp: Pick<WispApi, "searchMessages"> }).wisp = { searchMessages };
  });

  it("lists every conversation until something is typed", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: /Atlas/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Pixel/ })).toBeVisible();
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("finds messages through the backend, newest first, and opens one at its message", async () => {
    const user = userEvent.setup();
    const handlers = renderDialog();

    await user.click(screen.getByRole("button", { name: "Messages" }));
    await user.type(screen.getByRole("textbox", { name: "Search" }), " launch ");

    const results = await screen.findAllByRole("button", { name: /launch/ });
    expect(results.map((result) => result.textContent)).toEqual([
      "PixelThe launch banner is ready.",
      "AtlasReview the launch checklist.",
    ]);
    // Typing pauses before the search runs, so the whole query is searched once.
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledWith({ query: "launch" });

    await user.click(results[1]!);
    expect(handlers.onSelectMessage).toHaveBeenCalledWith("atlas", "older");
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(handlers.onSelectChat).not.toHaveBeenCalled();
  });

  it("matches Wisp names and roles without the backend", async () => {
    const user = userEvent.setup();
    searchMessages.mockResolvedValue({ ok: true, value: [] });
    const handlers = renderDialog();

    await user.click(screen.getByRole("button", { name: "Wisps" }));
    await user.type(screen.getByRole("textbox", { name: "Search" }), "design");

    expect(screen.queryByRole("button", { name: /Atlas/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Pixel/ }));
    expect(handlers.onSelectChat).toHaveBeenCalledWith("pixel");
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("asks for three characters before it searches messages", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Search" }), "at");

    // Two characters still match a name; message text needs one more.
    expect(screen.getByRole("button", { name: /Atlas/ })).toBeVisible();
    expect(screen.getByText("Type at least 3 characters to search messages.")).toBeVisible();
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    searchMessages.mockResolvedValue({ ok: true, value: [] });
    renderDialog();

    await user.type(screen.getByRole("textbox", { name: "Search" }), "zebra");

    expect(await screen.findByText("No results found")).toBeVisible();
  });
});
