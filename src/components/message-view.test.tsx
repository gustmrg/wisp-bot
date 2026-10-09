import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MessageView } from "@/components/message-view";

describe("MessageView", () => {
  it("marks a message sent from a schedule", () => {
    render(
      <MessageView
        message={{
          id: "sent",
          type: "outgoing",
          text: "Good morning",
          status: "complete",
          createdAt: "2026-10-07T12:00:00.000Z",
          scheduled: { scheduledMessageId: "scheduled-1", scheduledAt: "2026-10-06T21:00:00.000Z", timeZone: "UTC" },
        }}
      />,
    );
    expect(screen.getByText("Scheduled")).toBeTruthy();
  });

  it("does not mark a message typed then", () => {
    render(<MessageView message={{ id: "typed", type: "outgoing", text: "Hello", status: "complete" }} />);
    expect(screen.queryByText("Scheduled")).toBeNull();
  });

  it("shows the files attached to a sent message as files", () => {
    render(
      <MessageView
        message={{
          id: "attached",
          type: "outgoing",
          text: "Anexe os boletos\n\nAttached to the workspace:\n- `inbox/boleto.pdf`\n- `inbox/luz.pdf`",
          status: "complete",
        }}
      />,
    );
    expect(screen.getByText("Anexe os boletos")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Attached files" });
    expect(Array.from(list.querySelectorAll("li"), (item) => item.textContent)).toEqual(["boleto.pdf", "luz.pdf"]);
    expect(screen.getByTitle("inbox/boleto.pdf")).toBeTruthy();
    expect(screen.queryByText(/Attached to the workspace/)).toBeNull();
  });

  it("copies only the typed text of a message with attachments", async () => {
    // userEvent installs its own clipboard, so the stub goes in after it.
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <MessageView
        message={{
          id: "attached",
          type: "outgoing",
          text: "Anexe os boletos\n\nAttached to the workspace:\n- `inbox/boleto.pdf`",
          status: "complete",
          createdAt: "2026-10-07T12:00:00.000Z",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith("Anexe os boletos");
  });
});
