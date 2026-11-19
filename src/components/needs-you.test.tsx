import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NeedsYou } from "@/components/needs-you";
import { wispChatView } from "@/test/chat-fixtures";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

function request(conversationId: string, approvalId: string, minutes: number): ToolApprovalRequest {
  return {
    approvalId,
    conversationId,
    toolCallId: `${approvalId}-call`,
    toolName: "bash",
    category: "shell",
    scope: { kind: "workspace_path", display: "workspace" },
    summary: `git push ${approvalId}`,
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}

const chats = {
  atlas: wispChatView("atlas", { wisp: { name: "Atlas" } }),
  sage: wispChatView("sage", { wisp: { name: "Sage" } }),
};

describe("NeedsYou", () => {
  it("shows nothing when no approval is waiting", () => {
    const { container } = render(<NeedsYou chats={chats} approvals={{}} onOpenApprovals={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the Wisp waiting, counts several, and opens the Approvals tab", async () => {
    const user = userEvent.setup();
    const onOpenApprovals = vi.fn();
    const { rerender } = render(
      <NeedsYou chats={chats} approvals={{ sage: [request("sage", "push", 5)] }} onOpenApprovals={onOpenApprovals} />,
    );
    await user.click(screen.getByRole("button", { name: "Sage is waiting for your approval" }));
    expect(onOpenApprovals).toHaveBeenCalled();

    rerender(
      <NeedsYou
        chats={chats}
        approvals={{ atlas: [request("atlas", "older", 2)], sage: [request("sage", "push", 5)] }}
        onOpenApprovals={onOpenApprovals}
      />,
    );
    expect(screen.getByRole("button", { name: "2 approvals waiting" })).toBeVisible();
  });
});
