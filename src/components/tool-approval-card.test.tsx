import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToolApprovalCard } from "@/components/tool-approval-card";

describe("ToolApprovalCard", () => {
  it("describes an integration write and allows denying it", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-2",
          conversationId: "atlas",
          toolCallId: "tool-2",
          toolName: "linear_update_issue",
          category: "external_write",
          scope: { kind: "integration", display: "Linear issue ENG-42" },
          summary: "Update ENG-42: Fix sign-in",
          expiresAt: "2026-09-07T12:01:00.000Z",
        }}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve integration change?")).toBeVisible();
    expect(screen.getByText(/This action can change data in the connected service/)).toBeVisible();
    expect(screen.queryByText(/No file content/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenCalledWith("deny");
  });

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
