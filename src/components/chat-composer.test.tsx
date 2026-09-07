import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Chat } from "../../shared/conversations";
import { ChatComposer } from "@/components/chat-composer";

function wisp(id: string, name = id): Chat {
  return {
    id,
    name,
    label: "Test",
    description: "Test",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

const defaultProps = {
  status: "idle" as const,
  acknowledging: false,
  onAbort: vi.fn(),
  onSend: vi.fn(),
};

describe("ChatComposer", () => {
  it("submits Enter, preserves Shift+Enter, and clears a submitted draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatComposer {...defaultProps} chat={wisp("one", "One")} onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: "Message One" });

    await user.type(input, "First line{shift>}{enter}{/shift}Second line");
    expect(onSend).not.toHaveBeenCalled();
    await user.type(input, "{enter}");

    expect(onSend).toHaveBeenCalledWith("First line\nSecond line");
    expect(input).toHaveValue("");
  });

  it("resets and focuses when the keyed conversation changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ChatComposer key="one" {...defaultProps} chat={wisp("one", "One")} />);
    await user.type(screen.getByRole("textbox", { name: "Message One" }), "unsent");

    rerender(<ChatComposer key="two" {...defaultProps} chat={wisp("two", "Two")} />);

    const next = screen.getByRole("textbox", { name: "Message Two" });
    expect(next).toHaveValue("");
    expect(next).toHaveFocus();
  });

  it("disables circles and exposes the active stop control", () => {
    const onAbort = vi.fn();
    const circle: Chat = { ...wisp("crew", "Crew"), kind: "circle", memberIds: [] };
    const { rerender } = render(<ChatComposer {...defaultProps} chat={circle} />);
    expect(screen.getByRole("textbox", { name: "Message Crew" })).toBeDisabled();

    rerender(<ChatComposer {...defaultProps} chat={wisp("one", "One")} status="working" onAbort={onAbort} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    screen.getByRole("button", { name: "Stop response" }).click();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("keeps draft updates below unrelated siblings", async () => {
    const user = userEvent.setup();
    const renderSibling = vi.fn();
    function UnrelatedSidebar() {
      renderSibling();
      return <aside>Sidebar</aside>;
    }
    render(
      <>
        <UnrelatedSidebar />
        <ChatComposer {...defaultProps} chat={wisp("one", "One")} />
      </>,
    );

    await user.type(screen.getByRole("textbox", { name: "Message One" }), "local draft");

    expect(renderSibling).toHaveBeenCalledOnce();
  });
});

it("blocks first-run sends without losing the draft and offers configuration", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  const onConfigure = vi.fn();
  const props = { ...defaultProps, chat: wisp("new", "New"), onSend, onConfigure };
  const { rerender } = render(<ChatComposer {...props} status="configuration_required" />);
  const input = screen.getByRole("textbox", { name: "Message New" });
  await user.type(input, "First task{enter}");
  expect(onSend).not.toHaveBeenCalled();
  expect(input).toHaveValue("First task");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Configure AI model" }));
  expect(onConfigure).toHaveBeenCalledOnce();
  rerender(<ChatComposer {...props} status="idle" />);
  expect(input).toHaveValue("First task");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSend).toHaveBeenCalledWith("First task");
});
