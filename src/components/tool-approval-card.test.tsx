import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToolApprovalCard } from "@/components/tool-approval-card";

describe("ToolApprovalCard", () => {
  it("shows the bounded scope and returns only an explicit decision", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-1",
          conversationId: "atlas",
          toolCallId: "tool-1",
          toolName: "write",
          category: "create_file",
          scope: { kind: "workspace_path", display: "notes.txt" },
          summary: "Create notes.txt",
          expiresAt: "2026-09-02T12:01:00.000Z",
        }}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText(/Wisp atlas requested write for notes\.txt/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });
});
