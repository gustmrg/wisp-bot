import { act, render, screen } from "@testing-library/react";
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
        wispName="Atlas"
        allowAlwaysAvailable
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve integration change?")).toBeVisible();
    expect(screen.getByText(/This action can change data in the connected service/)).toBeVisible();
    expect(screen.queryByText(/No file content/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Always allow/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenCalledWith("deny");
  });

  it("shows the exact skill instructions and offers only allow once or deny", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-3",
          conversationId: "atlas",
          toolCallId: "tool-3",
          toolName: "save_skill",
          category: "save_skill",
          scope: { kind: "skill", display: "weekly-report" },
          summary: "Create skill weekly-report: Builds the weekly report",
          preview: "1. Collect issues\n2. Summarize",
          expiresAt: "2026-09-07T12:01:00.000Z",
        }}
        wispName="Atlas"
        allowAlwaysAvailable
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve skill?")).toBeVisible();
    expect(screen.getByLabelText("Skill instructions")).toHaveTextContent("1. Collect issues 2. Summarize");
    expect(screen.getByText(/Atlas wants to save the skill weekly-report/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Always allow/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
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
        wispName="Atlas"
        allowAlwaysAvailable
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText(/Atlas requested write for notes\.txt/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });

  it("counts down to expiry and offers a lasting Allow for workspace files only while auto-review is on", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    try {
      const onResolve = vi.fn();
      const request = {
        approvalId: "approval-3",
        conversationId: "atlas",
        toolCallId: "tool-3",
        toolName: "edit",
        category: "modify_file" as const,
        scope: { kind: "workspace_path" as const, display: "notes.txt" },
        summary: "Edit notes.txt",
        expiresAt: "2026-09-02T12:01:00.000Z",
      };
      const { rerender } = render(
        <ToolApprovalCard request={request} wispName="Atlas" allowAlwaysAvailable onResolve={onResolve} />,
      );
      expect(screen.getByText("Expires in 1:00")).toBeVisible();
      act(() => vi.advanceTimersByTime(52_000));
      expect(screen.getByText("Expires in 0:08")).toHaveClass("text-destructive");

      screen.getByRole("button", { name: "Always allow editing files" }).click();
      expect(onResolve).toHaveBeenCalledWith("allow_always");
      expect(screen.getByText(/Settings → General → Auto-review/)).toBeVisible();

      rerender(
        <ToolApprovalCard request={request} wispName="Atlas" allowAlwaysAvailable={false} onResolve={onResolve} />,
      );
      expect(screen.queryByRole("button", { name: /Always allow/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
