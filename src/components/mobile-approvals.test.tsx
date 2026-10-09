import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MobileApprovals } from "@/components/mobile-approvals";
import { MobileNavigation } from "@/components/mobile-navigation";
import { wispChatView } from "@/test/chat-fixtures";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

function request(conversationId: string, approvalId: string, expiresAt: string, summary: string): ToolApprovalRequest {
  return {
    approvalId,
    conversationId,
    toolCallId: `${approvalId}-call`,
    toolName: "write",
    category: "create_file",
    scope: { kind: "workspace_path", display: "notes.txt" },
    summary,
    expiresAt,
  };
}

const chats = {
  atlas: wispChatView("atlas", { wisp: { name: "Atlas" } }),
  beta: wispChatView("beta", { wisp: { name: "Beta" } }),
};

describe("MobileNavigation", () => {
  it("names each tab with its badge count, and leaves Approvals out without a handler", () => {
    const { rerender } = render(
      <MobileNavigation
        current="approvals"
        onConversations={vi.fn()}
        onApprovals={vi.fn()}
        onSettings={vi.fn()}
        unreadCount={3}
        approvalCount={2}
      />,
    );
    const bar = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(bar).getByRole("button", { name: "Wisps, 3 unread" })).not.toHaveAttribute("aria-current");
    expect(within(bar).getByRole("button", { name: "Approvals, 2 pending" })).toHaveAttribute("aria-current", "page");
    expect(within(bar).getByRole("button", { name: "Settings" })).toBeVisible();

    rerender(<MobileNavigation current="wisps" onConversations={vi.fn()} onSettings={vi.fn()} />);
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Wisps", "Settings"]);
  });
});

describe("MobileApprovals", () => {
  it("lists every pending approval, newest first, and resolves or opens its conversation", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const onOpenChat = vi.fn();
    render(
      <MobileApprovals
        chats={chats}
        approvals={{
          atlas: [request("atlas", "older", "2026-10-09T10:00:00.000Z", "Create notes.txt")],
          beta: [request("beta", "newer", "2026-10-09T10:05:00.000Z", "Create plan.md")],
          gone: [request("gone", "orphan", "2026-10-09T10:09:00.000Z", "Create lost.md")],
        }}
        allowAlwaysAvailable={false}
        unreadCount={0}
        onResolve={onResolve}
        onOpenChat={onOpenChat}
        onConversations={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Approvals" })).toHaveFocus();
    expect(screen.getByText("2 waiting for you")).toBeVisible();
    const items = screen.getAllByRole("article");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Beta: Create plan.md",
      "Atlas: Create notes.txt",
    ]);
    expect(screen.getByRole("button", { name: "Approvals, 2 pending" })).toHaveAttribute("aria-current", "page");

    await user.click(within(items[1]!).getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "older" }), "allow_once");
    await user.click(within(items[0]!).getByRole("button", { name: "Open the conversation with Beta" }));
    expect(onOpenChat).toHaveBeenCalledWith("beta");
  });

  it("says when nothing is waiting", () => {
    render(
      <MobileApprovals
        chats={chats}
        approvals={{}}
        allowAlwaysAvailable={false}
        unreadCount={0}
        onResolve={vi.fn()}
        onOpenChat={vi.fn()}
        onConversations={vi.fn()}
        onSettings={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Nothing is waiting for you.");
    expect(screen.getByRole("button", { name: "Approvals" })).toBeVisible();
  });
});
