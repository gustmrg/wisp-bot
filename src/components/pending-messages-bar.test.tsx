import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PendingMessagesBar } from "@/components/pending-messages-bar";
import type { QueuedMessage } from "../../shared/message-queue";
import type { ScheduledMessage } from "../../shared/scheduled-messages";

const message: ScheduledMessage = {
  id: "scheduled-1",
  conversationId: "one",
  text: "Summarize the news",
  schedule: { kind: "once", at: "2099-10-07T12:00:00.000Z" },
  timeZone: "UTC",
  nextRunAt: "2099-10-07T12:00:00.000Z",
  sentCount: 0,
  createdAt: "2026-10-06T12:00:00.000Z",
  updatedAt: "2026-10-06T12:00:00.000Z",
};

function controller() {
  return {
    update: vi.fn(async () => null),
    cancel: vi.fn(async () => null),
    sendNow: vi.fn(async (): Promise<string | null> => null),
  };
}

function queueActions() {
  return { update: vi.fn(async () => null), cancel: vi.fn(async (): Promise<string | null> => null) };
}

const queued: QueuedMessage[] = [
  { id: "queued-1", conversationId: "one", text: "Next question", createdAt: "2026-10-06T12:00:00.000Z" },
  {
    id: "queued-2",
    conversationId: "one",
    text: "From the schedule",
    createdAt: "2026-10-06T12:01:00.000Z",
    scheduled: { scheduledMessageId: "scheduled-9", scheduledAt: "2026-10-05T12:00:00.000Z", timeZone: "UTC" },
  },
];

describe("PendingMessagesBar", () => {
  it("lists queued messages first, marks the next one, and edits or removes them", async () => {
    const user = userEvent.setup();
    const actions = queueActions();
    render(<PendingMessagesBar queued={queued} scheduled={[message]} queue={actions} schedule={controller()} />);

    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("NextNext question"),
      expect.stringContaining("QueuedScheduledFrom the schedule"),
      expect.stringContaining("Summarize the news"),
    ]);
    await user.click(screen.getAllByRole("button", { name: "Remove from queue" })[1]!);
    expect(actions.cancel).toHaveBeenCalledWith("queued-2");

    await user.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]!);
    const text = await screen.findByRole("textbox", { name: "Message" });
    await user.clear(text);
    await user.type(text, "Better question");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(actions.update).toHaveBeenCalledWith("queued-1", "Better question");
  });

  it("lists scheduled messages and sends or cancels one", async () => {
    const user = userEvent.setup();
    const actions = controller();
    render(<PendingMessagesBar queued={[]} scheduled={[message]} queue={queueActions()} schedule={actions} />);

    expect(screen.getByRole("region", { name: "Pending messages" })).toHaveTextContent("Summarize the news");
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(actions.sendNow).toHaveBeenCalledWith("scheduled-1");
    await user.click(screen.getByRole("button", { name: "Cancel scheduled message" }));
    expect(actions.cancel).toHaveBeenCalledWith("scheduled-1");
  });

  it("shows why an action failed", async () => {
    const user = userEvent.setup();
    const actions = controller();
    actions.sendNow.mockResolvedValue("The Wisp was not found.");
    render(<PendingMessagesBar queued={[]} scheduled={[message]} queue={queueActions()} schedule={actions} />);
    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Wisp was not found.");
  });

  it("edits the text and time", async () => {
    const user = userEvent.setup();
    const actions = controller();
    render(<PendingMessagesBar queued={[]} scheduled={[message]} queue={queueActions()} schedule={actions} />);
    await user.click(screen.getByRole("button", { name: "Edit scheduled message" }));
    const text = await screen.findByRole("textbox", { name: "Message" });
    await user.clear(text);
    await user.type(text, "Summarize the tech news");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(actions.update).toHaveBeenCalledWith("scheduled-1", {
      text: "Summarize the tech news",
      at: new Date(message.nextRunAt),
    });
  });

  it("shows nothing without scheduled messages", () => {
    const { container } = render(
      <PendingMessagesBar queued={[]} scheduled={[]} queue={queueActions()} schedule={controller()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
