import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSummary, Message } from "@/chat-data";
import { ChatPanel, type ChatPanelProps } from "@/components/chat-panel";
import type { MessageWindow } from "@/lib/message-windows";

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 200;

const atlas: ChatSummary = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
};

function messages(from: number, to: number): Message[] {
  return Array.from({ length: to - from }, (_, index) => ({
    id: `m${from + index}`,
    type: "incoming",
    text: `Message ${from + index}`,
  }));
}

function transcript(held: Message[], overrides: Partial<MessageWindow> = {}): MessageWindow {
  return { epoch: 1, messages: held, olderCursor: null, newerCursor: null, loading: false, ...overrides };
}

// jsdom lays nothing out, so every message row is given a fixed height and the
// scroll position is limited to the content, as a browser limits it.
function rowsOf(element: Element | null): Element[] {
  return [...(element?.querySelectorAll("[data-message-id]") ?? [])];
}

function bottomOf(rows: number): number {
  return Math.max(0, rows * ROW_HEIGHT - VIEWPORT_HEIGHT);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return rowsOf(this.parentElement).indexOf(this) * ROW_HEIGHT;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ROW_HEIGHT);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return rowsOf(this).length * ROW_HEIGHT;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT);
  const positions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return Math.min(positions.get(this) ?? 0, bottomOf(rowsOf(this).length));
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    positions.set(this, Math.max(0, value));
  });
});

function renderPanel(held: MessageWindow | undefined, overrides: Partial<ChatPanelProps> = {}) {
  const props: ChatPanelProps = {
    chat: atlas,
    chats: { atlas },
    transcript: held,
    status: "idle",
    acknowledging: false,
    approvals: [],
    onAnswerPrompt: vi.fn(),
    onAbort: vi.fn(),
    onLoadOlder: vi.fn(),
    onLoadNewer: vi.fn(),
    onShowLatest: vi.fn(),
    onOpenDetails: vi.fn(),
    onRetry: vi.fn(),
    onResolveApproval: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
  const view = render(<ChatPanel {...props} />);
  return {
    props,
    scroller: screen.getByLabelText("Atlas conversation"),
    show: (next: MessageWindow | undefined, more: Partial<ChatPanelProps> = {}) =>
      view.rerender(<ChatPanel {...props} {...more} transcript={next} />),
  };
}

describe("ChatPanel transcript", () => {
  it("shows tool execution only in the chat, then removes it when the reply starts", () => {
    const request: Message = { id: "request", type: "outgoing", text: "Search the web", status: "complete" };
    const reply: Message = { id: "reply", type: "incoming", text: "", status: "streaming" };
    const { scroller, show } = renderPanel(transcript([request, reply]), {
      status: "working",
      activity: "Searching the web…",
    });

    expect(screen.getAllByText("Searching the web…")).toHaveLength(1);
    expect(scroller).toContainElement(screen.getByText("Searching the web…"));
    expect(screen.queryByText("Atlas is working…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();

    show(transcript([request, { ...reply, text: "Here is what I found." }]), {
      status: "working",
      activity: undefined,
    });
    expect(screen.getByText("Here is what I found.")).toBeInTheDocument();
    expect(screen.queryByText("Searching the web…")).not.toBeInTheDocument();
    expect(screen.queryByText("Atlas is working…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();

    show(transcript([request, { ...reply, text: "Here is what I found.", status: "complete" }]), { status: "idle" });
    expect(screen.queryByRole("list", { name: "Recent tool activity" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Search web — completed/)).not.toBeInTheDocument();
  });

  it("keeps the execution indicator hidden when a message is queued during the reply", () => {
    renderPanel(
      transcript([
        { id: "reply", type: "incoming", text: "Here is what I found.", status: "streaming" },
        { id: "queued", type: "outgoing", text: "Next question", status: "queued" },
      ]),
      { status: "working", activity: "Searching the web…" },
    );
    expect(screen.queryByText("Searching the web…")).not.toBeInTheDocument();
    expect(screen.queryByText("Atlas is working…")).not.toBeInTheDocument();
  });

  it("opens at the newest message once the first page arrives", () => {
    const { scroller, show, props } = renderPanel(undefined);
    expect(screen.queryByText("Message 9")).not.toBeInTheDocument();

    show(transcript(messages(0, 10)));

    expect(screen.getByText("Message 9")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(bottomOf(10));
    expect(props.onLoadOlder).not.toHaveBeenCalled();
  });

  it("loads an older page when the top comes into view, and keeps the view in place when it arrives", () => {
    const held = transcript(messages(5, 15), { olderCursor: "5" });
    const { scroller, show, props } = renderPanel(held);

    scroller.scrollTop = 60;
    fireEvent.scroll(scroller);
    expect(props.onLoadOlder).toHaveBeenCalledTimes(1);

    // While the page is on its way, scrolling does not ask for it again.
    show({ ...held, loading: true });
    fireEvent.scroll(scroller);
    expect(props.onLoadOlder).toHaveBeenCalledTimes(1);

    show(transcript(messages(0, 15)));
    // Five rows arrived above: the view moves down by their height, not to the bottom.
    expect(scroller.scrollTop).toBe(60 + 5 * ROW_HEIGHT);
  });

  it("keeps loading older pages while the transcript does not fill the view", () => {
    const { show, props } = renderPanel(transcript(messages(8, 10), { olderCursor: "8" }));
    expect(props.onLoadOlder).toHaveBeenCalledTimes(1);

    show(transcript(messages(6, 10), { olderCursor: "6" }));
    expect(props.onLoadOlder).toHaveBeenCalledTimes(2);

    // A page that failed leaves the window unchanged, and is not asked for again on its own.
    show(transcript(messages(6, 10), { olderCursor: "6" }));
    expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("follows new messages and a streaming reply in an attached window", () => {
    const { scroller, show } = renderPanel(transcript(messages(0, 10)));
    scroller.scrollTop = 100;

    show(transcript([...messages(0, 10), { id: "reply", type: "incoming", text: "Hi", status: "streaming" }]));
    expect(scroller.scrollTop).toBe(bottomOf(11));

    scroller.scrollTop = 100;
    show(transcript([...messages(0, 10), { id: "reply", type: "incoming", text: "Hi there", status: "streaming" }]));
    expect(scroller.scrollTop).toBe(bottomOf(11));
  });

  it("centers and highlights the message a window was opened on", () => {
    const { scroller, props } = renderPanel(
      transcript(messages(0, 14), { olderCursor: null, newerCursor: "13", targetMessageId: "m6" }),
    );

    expect(scroller.scrollTop).toBe(6 * ROW_HEIGHT - (VIEWPORT_HEIGHT - ROW_HEIGHT) / 2);
    expect(rowsOf(scroller).filter((row) => row.getAttribute("data-highlighted") === "true")).toEqual([
      screen.getByText("Message 6").closest("[data-message-id]"),
    ]);
    expect(props.onLoadNewer).not.toHaveBeenCalled();
  });

  it("stays put in a detached window, loads newer pages at the bottom, and offers a way back", async () => {
    const user = userEvent.setup();
    const held = transcript(messages(0, 14), { newerCursor: "13", targetMessageId: "m6" });
    const { scroller, show, props } = renderPanel(held, { status: "working" });
    const opened = scroller.scrollTop;
    // The work in progress belongs to the newest messages, which this window does not show.
    expect(screen.queryByText("Atlas is working…")).not.toBeInTheDocument();

    scroller.scrollTop = bottomOf(14);
    fireEvent.scroll(scroller);
    expect(props.onLoadNewer).toHaveBeenCalledTimes(1);

    // The newer page reaches the end: the window reattaches without jumping there.
    scroller.scrollTop = opened;
    show({ ...held, messages: messages(0, 20), newerCursor: "19" });
    expect(scroller.scrollTop).toBe(opened);
    show({ ...held, messages: messages(0, 22), newerCursor: null });
    expect(scroller.scrollTop).toBe(opened);
    // Reattaching to a visible reply must not add an execution indicator below it.
    expect(screen.queryByText("Atlas is working…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

    show(held);
    await user.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(props.onShowLatest).toHaveBeenCalledTimes(1);

    // The latest page is a new window, so the view goes to its newest message.
    show(transcript(messages(12, 22), { epoch: 2, olderCursor: "12" }));
    expect(scroller.scrollTop).toBe(bottomOf(10));
  });
});
