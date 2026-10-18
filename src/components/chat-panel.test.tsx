import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/chat-data";
import { ChatPanel, type ChatPanelProps } from "@/components/chat-panel";
import type { MessageWindow } from "@/lib/message-windows";
import { circleChatView, testWisp, wispChatView } from "@/test/chat-fixtures";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 200;
let viewportHeight = VIEWPORT_HEIGHT;

const atlas = wispChatView("atlas", { wisp: { name: "Atlas", role: "Research", soul: "" } });

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
  return Math.max(0, rows * ROW_HEIGHT - viewportHeight);
}

/** Scrolls the transcript as the person does, with the wheel, rather than as content moving under it. */
function scrollAsPerson(scroller: HTMLElement, top: number): void {
  fireEvent.wheel(scroller);
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

// jsdom has no ResizeObserver; the tests report resizes themselves.
let resized: () => void = () => {};
class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resized = () => callback([], this as unknown as ResizeObserver);
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  viewportHeight = VIEWPORT_HEIGHT;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return rowsOf(this.parentElement).indexOf(this) * ROW_HEIGHT;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ROW_HEIGHT);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return rowsOf(this).length * ROW_HEIGHT;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  const positions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return Math.min(positions.get(this) ?? 0, bottomOf(rowsOf(this).length));
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    positions.set(this, Math.max(0, value));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel(held: MessageWindow | undefined, overrides: Partial<ChatPanelProps> = {}) {
  const props: ChatPanelProps = {
    chat: atlas,
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

    // The header says it too; below the messages it shows once.
    expect(within(scroller).getAllByText("Searching the web…")).toHaveLength(1);
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

  it("keeps the execution indicator below text the Wisp wrote before using a tool", () => {
    const { scroller } = renderPanel(
      transcript([
        { id: "request", type: "outgoing", text: "Search the web", status: "complete" },
        { id: "request:assistant", type: "incoming", text: "Let me look that up.", status: "complete" },
      ]),
      { status: "working", activity: "Searching the web…" },
    );
    expect(screen.getByText("Let me look that up.")).toBeInTheDocument();
    expect(within(scroller).getByText("Searching the web…")).toBeInTheDocument();
  });

  it("keeps the execution indicator hidden when a message is queued during the reply", () => {
    const { scroller } = renderPanel(
      transcript([
        { id: "reply", type: "incoming", text: "Here is what I found.", status: "streaming" },
        { id: "queued", type: "outgoing", text: "Next question", status: "queued" },
      ]),
      { status: "working", activity: "Searching the web…" },
    );
    expect(within(scroller).queryByText("Searching the web…")).not.toBeInTheDocument();
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

    scrollAsPerson(scroller, 60);
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

  it("offers a way to the newest messages once the reader scrolls up, and back down hides it", () => {
    const { scroller } = renderPanel(transcript(messages(0, 10)));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

    scrollAsPerson(scroller, 40);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    scrollAsPerson(scroller, bottomOf(10));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("keeps a reader's place when a reply arrives, and marks the way to it", async () => {
    const user = userEvent.setup();
    const { scroller, show, props } = renderPanel(transcript(messages(0, 10)));
    scrollAsPerson(scroller, 40);

    show(transcript([...messages(0, 10), { id: "reply", type: "incoming", text: "Hi", status: "streaming" }]));
    expect(scroller.scrollTop).toBe(40);

    await user.click(screen.getByRole("button", { name: "Jump to latest, new messages below" }));
    // The window already holds the newest messages, so nothing is loaded.
    expect(props.onShowLatest).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(bottomOf(11));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("keeps following when the view moves without the person scrolling", () => {
    const { scroller, show } = renderPanel(transcript(messages(0, 10)));
    // Content changing size moved the view away from the bottom; no wheel, key or touch did.
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(bottomOf(10));

    show(transcript([...messages(0, 10), { id: "reply", type: "incoming", text: "Done", status: "complete" }]));
    expect(scroller.scrollTop).toBe(bottomOf(11));
  });

  it("follows the reply to the person's own message even after they had scrolled up", () => {
    const { scroller, show } = renderPanel(transcript(messages(0, 10)));
    scrollAsPerson(scroller, 40);
    const sent = { id: "sent", type: "outgoing" as const, text: "And then?", status: "queued" as const };

    show(transcript([...messages(0, 10), sent]));
    show(transcript([...messages(0, 10), sent, { id: "reply", type: "incoming", text: "Then", status: "streaming" }]));
    expect(scroller.scrollTop).toBe(bottomOf(12));
  });

  it("always shows the person's own message", () => {
    const { scroller, show } = renderPanel(transcript(messages(0, 10)));
    scrollAsPerson(scroller, 40);

    show(transcript([...messages(0, 10), { id: "sent", type: "outgoing", text: "And then?", status: "queued" }]));
    expect(scroller.scrollTop).toBe(bottomOf(11));
  });

  it("stays at the newest messages when the view shrinks, as when a keyboard opens", () => {
    const { scroller } = renderPanel(transcript(messages(0, 10)));
    expect(scroller.scrollTop).toBe(bottomOf(10));

    viewportHeight = 120;
    resized();
    expect(scroller.scrollTop).toBe(bottomOf(10));

    // A reader further up is left where they are.
    scrollAsPerson(scroller, 40);
    viewportHeight = 80;
    resized();
    expect(scroller.scrollTop).toBe(40);
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

    show(held);
    await user.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(props.onShowLatest).toHaveBeenCalledTimes(1);

    // The latest page is a new window, so the view goes to its newest message.
    show(transcript(messages(12, 22), { epoch: 2, olderCursor: "12" }));
    expect(scroller.scrollTop).toBe(bottomOf(10));
  });
});

describe("ChatPanel approvals", () => {
  it("allows every waiting approval at once from the conversation", async () => {
    const user = userEvent.setup();
    const approval = (approvalId: string): ToolApprovalRequest => ({
      approvalId,
      conversationId: "atlas",
      toolCallId: `${approvalId}-call`,
      toolName: "write",
      category: "create_file",
      scope: { kind: "workspace_path", display: `${approvalId}.txt` },
      summary: `Create ${approvalId}.txt`,
      expiresAt: "2026-10-11T12:01:00.000Z",
    });
    const { props } = renderPanel(transcript(messages(0, 2)), { approvals: [approval("one"), approval("two")] });

    expect(screen.getAllByRole("region", { name: "Tool approval required" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Allow all 2 once" }));
    expect(props.onResolveApproval).toHaveBeenCalledTimes(2);
    expect(props.onResolveApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "two" }), "allow_once");
  });
});

describe("ChatPanel identity", () => {
  it("takes on the Wisp's color and says what it does under its name", () => {
    renderPanel(transcript(messages(0, 1)));
    expect(document.querySelector("main")?.style.getPropertyValue("--wisp")).toMatch(/#[0-9a-f]{6}/i);
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("keeps the default composer button for a gray Wisp", () => {
    const { show } = renderPanel(transcript(messages(0, 1)), {
      chat: wispChatView("atlas", { wisp: { name: "Atlas", color: "#262626" } }),
    });
    expect(document.querySelector("main")).toHaveAttribute("data-neutral-accent");
    show(transcript(messages(0, 1)), { chat: wispChatView("atlas", { wisp: { name: "Atlas", color: "#3c82f6" } }) });
    expect(document.querySelector("main")).not.toHaveAttribute("data-neutral-accent");
  });

  it("says when the Wisp is working, waiting, or failed", () => {
    const { show } = renderPanel(transcript(messages(0, 1)), { status: "working" });
    expect(screen.getByText("Working…")).toBeInTheDocument();
    show(transcript([{ id: "f", type: "incoming", text: "", status: "failed" }]), { status: "idle" });
    expect(screen.getByText("Couldn't reply")).toBeInTheDocument();
  });

  it("says under its name what the Wisp is doing while it works", () => {
    renderPanel(transcript(messages(0, 1)), { status: "working", activity: "Searching the web" });
    expect(document.querySelector(".chat-subline")).toHaveTextContent("Searching the web");
  });

  it("introduces a Wisp with nothing said yet and sends a suggested first message", async () => {
    const { props } = renderPanel(transcript([]));
    expect(screen.getByRole("heading", { name: "Hi, I'm Atlas" })).toBeInTheDocument();
    const starters = within(screen.getByRole("list", { name: "Suggested messages" })).getAllByRole("button");
    expect(starters.map((button) => button.textContent)).toEqual([
      "What can you help me with?",
      "Help me plan my week",
      "Every morning, send me a short summary of the news",
      "How can I connect you to my email or calendar?",
    ]);
    await userEvent.click(starters[1]!);
    expect(props.onSend).toHaveBeenCalledWith("Help me plan my week");
  });

  it("suggests building the team first when the Wisp is the person's only one", () => {
    renderPanel(transcript([]), { soleWisp: true });
    const starters = within(screen.getByRole("list", { name: "Suggested messages" })).getAllByRole("button");
    expect(starters.map((button) => button.textContent)).toEqual([
      "Help me build a team of Wisps",
      "Create an assistant Wisp for me",
      "What can you help me with?",
      "Help me plan my week",
    ]);
  });

  it("offers no suggestion to send until the Wisp can take a message", () => {
    renderPanel(transcript([]), { status: "configuration_required" });
    for (const button of within(screen.getByRole("list", { name: "Suggested messages" })).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("does not introduce the Wisp once there are messages", () => {
    renderPanel(transcript(messages(0, 1)));
    expect(screen.queryByRole("heading", { name: "Hi, I'm Atlas" })).not.toBeInTheDocument();
  });
});

describe("ChatPanel circles", () => {
  it("names the Wisp above each run of its replies", () => {
    const crew = circleChatView("crew", [testWisp("quill", { name: "Quill" }), testWisp("forge", { name: "Forge" })], {
      name: "Launch crew",
    });
    renderPanelIn(crew, [
      { id: "1", type: "outgoing", text: "What's left?" },
      { id: "2", type: "incoming", text: "Changelog is up.", authorId: "quill" },
      { id: "3", type: "incoming", text: "And the blog post.", authorId: "quill" },
      { id: "4", type: "incoming", text: "Tests are green.", authorId: "forge" },
    ]);
    expect(screen.getAllByText("Quill")).toHaveLength(1);
    expect(screen.getAllByText("Forge")).toHaveLength(1);
  });
});

function renderPanelIn(chat: ChatPanelProps["chat"], held: Message[]) {
  return render(
    <ChatPanel
      chat={chat}
      transcript={transcript(held)}
      status="idle"
      acknowledging={false}
      approvals={[]}
      onAnswerPrompt={vi.fn()}
      onAbort={vi.fn()}
      onLoadOlder={vi.fn()}
      onLoadNewer={vi.fn()}
      onShowLatest={vi.fn()}
      onOpenDetails={vi.fn()}
      onRetry={vi.fn()}
      onResolveApproval={vi.fn()}
      onSend={vi.fn()}
    />,
  );
}

describe("ChatPanel steps", () => {
  it("shows the tools used in this turn while the Wisp works, and hides them after", () => {
    const steps = [
      { toolCallId: "1", toolName: "read", phase: "completed" as const },
      { toolCallId: "2", toolName: "grep", phase: "completed" as const, isError: true },
      { toolCallId: "3", toolName: "read", phase: "started" as const },
    ];
    const { show } = renderPanel(transcript(messages(0, 1)), { status: "working", steps });
    const trail = screen.getByRole("list", { name: "What Atlas has done so far" });
    expect(trail.querySelectorAll("li")).toHaveLength(3);
    expect(trail).toHaveTextContent("Search workspace, failed");
    expect(trail).toHaveTextContent("Read file, running");

    show(transcript(messages(0, 1)), { status: "idle", steps });
    expect(screen.queryByRole("list", { name: "What Atlas has done so far" })).not.toBeInTheDocument();
  });
});
