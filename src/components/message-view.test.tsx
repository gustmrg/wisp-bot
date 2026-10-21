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

  it("marks a Wisp's message that one of its jobs sent", () => {
    render(
      <MessageView
        message={{
          id: "job-run-1",
          type: "incoming",
          text: "Two new posts",
          status: "complete",
          job: { jobId: "job-1", runId: "run-1", title: "Blog watch" },
        }}
      />,
    );
    expect(screen.getByText("Job · Blog watch")).toBeTruthy();
  });

  it("marks a Wisp's reply its fallback model wrote", () => {
    render(
      <MessageView
        message={{ id: "reply", type: "incoming", text: "Hi", status: "complete", fallbackModel: "Backup" }}
      />,
    );
    expect(screen.getByText("Fallback · Backup")).toBeTruthy();
  });

  it("says why a reply failed beside the mark, not as something the Wisp said", () => {
    const { container } = render(
      <MessageView
        message={{
          id: "r:assistant",
          type: "incoming",
          text: "",
          status: "failed",
          error: { code: "model_unavailable", message: "The provider is out of credits." },
        }}
      />,
    );
    expect(screen.getByText("Failed · The provider is out of credits.")).toBeTruthy();
    expect(container.querySelector(".message-bubble")).toBeNull();
  });

  it("keeps a failed reply's partial text and says why it stopped", () => {
    render(
      <MessageView
        message={{
          id: "r:assistant",
          type: "incoming",
          text: "Here is the first half",
          status: "failed",
          error: { code: "unavailable", message: "The connection dropped." },
        }}
      />,
    );
    expect(screen.getByText("Here is the first half")).toBeTruthy();
    expect(screen.getByText("Failed · The connection dropped.")).toBeTruthy();
  });

  it("still shows an older failed reply whose reason was saved as its text", () => {
    render(<MessageView message={{ id: "r:assistant", type: "incoming", text: "Wisp stopped.", status: "failed" }} />);
    expect(screen.getByText("Wisp stopped.")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
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

  it("sets apart the workspace files a message to a Wisp mentions", () => {
    const text = 'Compare @docs/plan.md with @"inbox/meeting notes.md". Mail ada@example.com';
    const { container } = render(
      <MessageView message={{ id: "files", type: "outgoing", text, status: "complete" }} fileMentions />,
    );
    expect(screen.getByTitle("docs/plan.md in the workspace")).toHaveTextContent("@docs/plan.md");
    expect(screen.getByTitle("inbox/meeting notes.md in the workspace")).toHaveTextContent('@"inbox/meeting notes.md"');
    expect(container.querySelectorAll("[title$='in the workspace']")).toHaveLength(2);
    expect(container).toHaveTextContent(text, { normalizeWhitespace: false });
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
