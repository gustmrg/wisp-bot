import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
