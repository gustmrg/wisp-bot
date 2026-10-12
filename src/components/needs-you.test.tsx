import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NeedsYou } from "@/components/needs-you";
import { WispOrbs } from "@/components/wisp-orbs";
import { wispChatView } from "@/test/chat-fixtures";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

function request(
  conversationId: string,
  approvalId: string,
  minutes: number,
  category: ToolApprovalRequest["category"] = "shell",
): ToolApprovalRequest {
  return {
    approvalId,
    conversationId,
    toolCallId: `${approvalId}-call`,
    toolName: "bash",
    category,
    scope: { kind: "workspace_path", display: "workspace" },
    summary: `git push ${approvalId}`,
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}

const chats = {
  atlas: wispChatView("atlas", { wisp: { name: "Atlas" } }),
  sage: wispChatView("sage", { wisp: { name: "Sage" } }),
};

function renderNeedsYou(approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>) {
  const props = {
    onResolve: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenApprovals: vi.fn(),
  };
  render(<NeedsYou chats={chats} approvals={approvals} allowAlwaysAvailable={false} {...props} />);
  return props;
}

describe("NeedsYou", () => {
  it("shows nothing when no approval is waiting", () => {
    renderNeedsYou({});
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
  });

  it("answers the latest approval from the list, and points to the rest", async () => {
    const user = userEvent.setup();
    const older = request("atlas", "older", 2);
    const latest = request("sage", "latest", 8);
    const { onResolve, onOpenApprovals } = renderNeedsYou({ atlas: [older], sage: [latest] });

    const card = screen.getByRole("region", { name: "Needs you" });
    expect(card).toHaveTextContent("Sage wants to run a command");
    expect(card).toHaveTextContent("git push latest");

    await user.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith(latest, "allow_once");
    await user.click(within(card).getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenCalledWith(latest, "deny");

    await user.click(within(card).getByRole("button", { name: /1 more waiting/ }));
    expect(onOpenApprovals).toHaveBeenCalled();
  });

  it("asks for a review of a job instead of a one-tap answer", () => {
    renderNeedsYou({ sage: [request("sage", "job", 5, "schedule_job")] });
    const card = screen.getByRole("region", { name: "Needs you" });
    expect(within(card).getByRole("button", { name: "Review" })).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
  });

  it("shows the whole request in a sheet, which can open the conversation", async () => {
    const user = userEvent.setup();
    const pending = request("sage", "push", 5);
    const { onResolve, onOpenChat } = renderNeedsYou({ sage: [pending] });

    await user.click(screen.getByRole("button", { name: /Show details/ }));
    const sheet = screen.getByRole("dialog", { name: "Sage wants to run a command" });
    expect(within(sheet).getByText("Approve command?")).toBeVisible();
    await user.click(within(sheet).getByRole("button", { name: "Open conversation" }));
    expect(onOpenChat).toHaveBeenCalledWith("sage");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show details/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith(pending, "allow_once");
  });
});

describe("NeedsYou on the desktop", () => {
  it("lists every waiting approval in a dialog when there is no Approvals tab", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const older = request("atlas", "older", 2);
    render(
      <NeedsYou
        chats={chats}
        approvals={{ atlas: [older], sage: [request("sage", "latest", 8)] }}
        allowAlwaysAvailable={false}
        onResolve={onResolve}
        onOpenChat={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /1 more waiting/ }));
    const dialog = screen.getByRole("dialog", { name: "Approvals" });
    expect(within(dialog).getAllByRole("article")).toHaveLength(2);
    const atlasEntry = within(dialog).getByRole("article", { name: /Atlas/ });
    await user.click(within(atlasEntry).getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith(older, "allow_once");
  });
});

describe("WispOrbs", () => {
  it("puts the Wisps that need the person first and names what each is doing", async () => {
    const user = userEvent.setup();
    const onSelectChat = vi.fn();
    render(
      <WispOrbs
        chats={{ ...chats, quill: wispChatView("quill", { wisp: { name: "Quill" } }) }}
        statuses={{ atlas: "working" }}
        approvals={{ sage: [request("sage", "push", 5)] }}
        failedChats={{ quill: true }}
        onSelectChat={onSelectChat}
      />,
    );
    const orbs = within(screen.getByRole("navigation", { name: "Your Wisps" })).getAllByRole("button");
    expect(orbs.map((orb) => orb.getAttribute("aria-label"))).toEqual([
      "Sage, waiting for your approval",
      "Atlas, working",
      "Quill, the last reply failed",
    ]);
    await user.click(orbs[1]!);
    expect(onSelectChat).toHaveBeenCalledWith("atlas");
  });
});
