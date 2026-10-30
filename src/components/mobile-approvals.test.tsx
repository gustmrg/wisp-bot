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

  it("sizes every tab for the longest name, so the bar keeps its width on each tab", () => {
    const { rerender } = render(
      <MobileNavigation current="wisps" onConversations={vi.fn()} onApprovals={vi.fn()} onSettings={vi.fn()} />,
    );
    const widest = () => screen.getAllByRole("button").map((button) => button.getAttribute("data-widest"));
    expect(widest()).toEqual(["Approvals", "Approvals", "Approvals"]);

    rerender(<MobileNavigation current="settings" onConversations={vi.fn()} onSettings={vi.fn()} />);
    expect(widest()).toEqual(["Settings", "Settings"]);
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
    await user.click(within(items[0]!).getByRole("button", { name: /Show details/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open conversation" }));
    expect(onOpenChat).toHaveBeenCalledWith("beta");
  });

  it("keeps each card to the two common answers, with the rest in its sheet", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const asked: ToolApprovalRequest = {
      ...request("atlas", "linear", "2026-10-09T10:00:00.000Z", "Update ENG-42"),
      category: "integration_call",
      scope: { kind: "integration", display: "Linear" },
      alwaysAllowTool: true,
    };
    render(
      <MobileApprovals
        chats={chats}
        approvals={{ atlas: [asked] }}
        unreadCount={0}
        onResolve={onResolve}
        onOpenChat={vi.fn()}
        onConversations={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const card = screen.getByRole("article");
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([expect.stringContaining("Update ENG-42"), "Deny", "Allow once"]);

    await user.click(within(card).getByRole("button", { name: /Show details/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Always allow this tool" }));
    expect(onResolve).toHaveBeenCalledWith(asked, "allow_always");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Allow all outside the list, so scrolling cannot take it away", () => {
    render(
      <MobileApprovals
        chats={chats}
        approvals={{
          atlas: [request("atlas", "older", "2026-10-09T10:00:00.000Z", "Create notes.txt")],
          beta: [request("beta", "newer", "2026-10-09T10:05:00.000Z", "Create plan.md")],
        }}
        unreadCount={0}
        onResolve={vi.fn()}
        onOpenChat={vi.fn()}
        onConversations={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    const allowAll = screen.getByRole("button", { name: "Allow all 2 once" });
    expect(allowAll.closest(".mobile-approvals-list")).toBeNull();
  });

  it("allows every waiting approval at once", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <MobileApprovals
        chats={chats}
        approvals={{
          atlas: [request("atlas", "older", "2026-10-09T10:00:00.000Z", "Create notes.txt")],
          beta: [request("beta", "newer", "2026-10-09T10:05:00.000Z", "Create plan.md")],
        }}
        unreadCount={0}
        onResolve={onResolve}
        onOpenChat={vi.fn()}
        onConversations={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Allow all 2 once" }));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "newer" }), "allow_once");
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "older" }), "allow_once");
  });

  it("says when nothing is waiting", () => {
    render(
      <MobileApprovals
        chats={chats}
        approvals={{}}
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
