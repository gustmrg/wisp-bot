import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailsPanel } from "@/components/details-panel";
import { wispChatView } from "@/test/chat-fixtures";

const chat = wispChatView("atlas", {
  wisp: { name: "Atlas", role: "Research", soul: "Finds relevant information" },
});

function renderDetails(onDelete = vi.fn()): void {
  render(
    <DetailsPanel
      chat={chat}
      wisps={{ atlas: chat.wisp }}
      width={318}
      onChange={vi.fn()}
      onChangeWisp={vi.fn()}
      onClose={vi.fn()}
      onDelete={onDelete}
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

describe("DetailsPanel deletion", () => {
  it("requires explicit confirmation and describes the data being removed", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderDetails(onDelete);

    await user.click(screen.getByRole("button", { name: "Delete Wisp" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Delete Atlas?" })).toBeVisible();
    expect(screen.getByText(/conversation history and settings/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(onDelete).toHaveBeenCalledOnce();
  });
});
