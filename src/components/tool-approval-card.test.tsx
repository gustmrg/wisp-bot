import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AllowAllApprovals, ToolApprovalCard } from "@/components/tool-approval-card";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

describe("ToolApprovalCard", () => {
  it("shows everything a job may do and allows it only once", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-job",
          conversationId: "atlas",
          toolCallId: "tool-job",
          toolName: "schedule_job",
          category: "schedule_job",
          scope: { kind: "job", display: "Job openings" },
          summary: "Schedule Job openings",
          job: {
            title: "Job openings",
            schedule: "Every day at 10:00 (America/Sao_Paulo)",
            nextRunAt: "2026-10-12T13:00:00.000Z",
            instructions: "Search the boards for remote roles.",
            skills: ["job-search"],
            tools: ["web_search", "run_command"],
          },
          expiresAt: "2026-10-11T12:01:00.000Z",
        }}
        wispName="Atlas"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve job?")).toBeVisible();
    expect(screen.getByText("Job openings")).toBeVisible();
    expect(screen.getByText("Every day at 10:00 (America/Sao_Paulo)")).toBeVisible();
    expect(screen.getByText("Search web, Run command")).toBeVisible();
    expect(screen.getByText("job-search")).toBeVisible();
    expect(screen.getByLabelText("Job instructions")).toHaveTextContent("Search the boards for remote roles.");
    expect(screen.queryByRole("button", { name: /Always/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });

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

  it("offers to always allow an MCP tool for this Wisp only when the request allows it", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const request = {
      approvalId: "approval-4",
      conversationId: "atlas",
      toolCallId: "tool-4",
      toolName: "mcp_docs_search",
      category: "integration_call" as const,
      scope: { kind: "integration" as const, display: "Docs" },
      summary: "search — query: wisp",
      expiresAt: "2026-09-07T12:01:00.000Z",
    };
    const { rerender } = render(<ToolApprovalCard request={request} wispName="Atlas" onResolve={onResolve} />);
    expect(screen.queryByRole("button", { name: /Always allow/ })).not.toBeInTheDocument();

    rerender(
      <ToolApprovalCard request={{ ...request, alwaysAllowTool: true }} wispName="Atlas" onResolve={onResolve} />,
    );
    expect(
      screen.getByText(/Always allow applies to Atlas only; a single tool asks again if it changes/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Always allow all of Docs" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Always allow this tool" }));
    expect(onResolve).toHaveBeenCalledWith("allow_always");

    rerender(
      <ToolApprovalCard
        request={{ ...request, alwaysAllowTool: true, alwaysAllowIntegration: true }}
        wispName="Atlas"
        onResolve={onResolve}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Always allow all of Docs" }));
    expect(onResolve).toHaveBeenCalledWith("allow_integration");
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
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText(/Atlas requested write for notes\.txt/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });

  it("counts down to expiry and offers a lasting Allow for workspace files for this Wisp", async () => {
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
      render(<ToolApprovalCard request={request} wispName="Atlas" onResolve={onResolve} />);
      expect(screen.getByText("Expires in 1:00")).toBeVisible();
      act(() => vi.advanceTimersByTime(52_000));
      expect(screen.getByText("Expires in 0:08")).toHaveClass("text-destructive");

      screen.getByRole("button", { name: "Always allow editing files" }).click();
      expect(onResolve).toHaveBeenCalledWith("allow_always");
      expect(screen.getByText(/apply to Atlas only\. Change them in Wisp settings → Access/)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fileApproval(approvalId: string): ToolApprovalRequest {
  return {
    approvalId,
    conversationId: "atlas",
    toolCallId: `${approvalId}-call`,
    toolName: "write",
    category: "create_file",
    scope: { kind: "workspace_path", display: `${approvalId}.txt` },
    summary: `Create ${approvalId}.txt`,
    expiresAt: "2026-10-11T12:01:00.000Z",
  };
}

describe("AllowAllApprovals", () => {
  it("allows every approval a tap may answer once, and leaves skills and jobs to their review", async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn();
    const skill: ToolApprovalRequest = {
      ...fileApproval("skill"),
      category: "save_skill",
      scope: { kind: "skill", display: "notes" },
    };
    const requests = [fileApproval("one"), skill, fileApproval("two"), fileApproval("three")];
    const { rerender } = render(<AllowAllApprovals requests={requests} onAllow={onAllow} />);

    expect(screen.getByText("1 needs a review", { exact: false })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Allow all 3 once" }));
    expect(onAllow.mock.calls.map(([request]) => request.approvalId)).toEqual(["one", "two", "three"]);
    // Answered ones are not offered again while they wait to leave the list.
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();

    rerender(<AllowAllApprovals requests={[skill]} onAllow={onAllow} />);
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();
  });

  it("is not offered for a single approval", () => {
    render(<AllowAllApprovals requests={[fileApproval("one")]} onAllow={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();
  });
});
