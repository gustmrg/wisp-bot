import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AllowAllApprovals, approvalAsk, ToolApprovalCard } from "@/components/tool-approval-card";
import { approvalWispName } from "@/lib/chat-schema";
import { wispChatView } from "@/test/chat-fixtures";
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

  it("shows the Wisp to create in full and creates it only once", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-wisp",
          conversationId: "chief",
          toolCallId: "tool-wisp",
          toolName: "create_wisp",
          category: "manage_wisp",
          scope: { kind: "wisp", display: "Quill" },
          summary: 'Create the Wisp "Quill"',
          wisp: { action: "create", name: "Quill", changes: { name: "Quill", role: "Writing", soul: "# Quill" } },
          expiresAt: "2026-10-11T12:01:00.000Z",
        }}
        wispName="Chief"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve new Wisp?")).toBeVisible();
    expect(screen.getByText("Quill")).toBeVisible();
    expect(screen.getByText("Writing")).toBeVisible();
    expect(screen.getByLabelText("Wisp soul")).toHaveTextContent("# Quill");
    expect(screen.queryByRole("button", { name: /Always/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });

  it("shows extended Wisp fields including model, fallback, memory, and appearance", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-wisp-ext",
          conversationId: "chief",
          toolCallId: "tool-wisp-ext",
          toolName: "update_wisp",
          category: "manage_wisp",
          scope: { kind: "wisp", display: "Quill" },
          summary: 'Change the Wisp "Quill"',
          wisp: {
            action: "update",
            name: "Quill",
            changes: {
              color: "blue",
              body: "drop",
              model: "GPT-5 from OpenAI (reasoning: high)",
              fallback: "Claude Haiku from Anthropic",
              memory: "off",
            },
          },
          expiresAt: "2026-10-11T12:01:00.000Z",
        }}
        wispName="Chief"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve Wisp change?")).toBeVisible();
    expect(screen.getByText("color blue, body drop")).toBeVisible();
    expect(screen.getByText("GPT-5 from OpenAI (reasoning: high)")).toBeVisible();
    expect(screen.getByText("Claude Haiku from Anthropic")).toBeVisible();
    expect(screen.getByText("Off")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Always/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
  });

  it("shows circle creation and update details clearly with no lasting allow or block choices", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const createRequest: ToolApprovalRequest = {
      approvalId: "approval-circle-create",
      conversationId: "chief",
      toolCallId: "tool-circle-create",
      toolName: "create_circle",
      category: "manage_wisp",
      scope: { kind: "wisp", display: "Engineering" },
      summary: 'Create the circle "Engineering"',
      wisp: {
        target: "circle",
        action: "create",
        name: "Engineering",
        changes: {
          name: "Engineering",
          description: "Ship features together",
          members: ["Atlas", "Quill"],
          lead: "Atlas",
          responder: "auto",
        },
      },
      expiresAt: "2026-10-11T12:01:00.000Z",
    };

    const { rerender } = render(<ToolApprovalCard request={createRequest} wispName="Chief" onResolve={onResolve} />);

    expect(approvalAsk(createRequest)).toBe("wants to create a circle");
    expect(screen.getByText("Approve new circle?")).toBeVisible();
    expect(screen.getByText("Engineering")).toBeVisible();
    expect(screen.getByText("Ship features together")).toBeVisible();
    expect(screen.getByText("Atlas, Quill")).toBeVisible();
    expect(screen.getByText("Atlas")).toBeVisible();
    expect(screen.getByText("Decision model")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Always/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /block/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onResolve).toHaveBeenLastCalledWith("allow_once");

    const updateRequest: ToolApprovalRequest = {
      ...createRequest,
      approvalId: "approval-circle-update",
      toolName: "update_circle",
      wisp: {
        target: "circle",
        action: "update",
        name: "Engineering",
        changes: { name: "Platform", responder: "lead" },
      },
    };
    rerender(<ToolApprovalCard request={updateRequest} wispName="Chief" onResolve={onResolve} />);
    expect(approvalAsk(updateRequest)).toBe("wants to change a circle");
    expect(screen.getByText("Approve circle change?")).toBeVisible();
    expect(screen.getByText("Platform")).toBeVisible();
    expect(screen.getByText("Lead")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(onResolve).toHaveBeenLastCalledWith("allow_once");
  });

  it("attributes consultation approvals to the consulted Wisp inside the caller's conversation", () => {
    const chiefChat = wispChatView("chief", { wisp: { name: "Chief" } });
    const atlasWisp = wispChatView("atlas", { wisp: { name: "Atlas" } }).wisp;
    expect(approvalWispName(chiefChat, { wispId: "atlas" }, { chief: chiefChat.wisp, atlas: atlasWisp })).toBe("Atlas");
    expect(approvalWispName(chiefChat, {}, { chief: chiefChat.wisp, atlas: atlasWisp })).toBe("Chief");
  });

  it("asks to confirm deleting a Wisp, as deleting it from its settings does", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-delete",
          conversationId: "chief",
          toolCallId: "tool-delete",
          toolName: "delete_wisp",
          category: "manage_wisp",
          scope: { kind: "wisp", display: "Quill" },
          summary: 'Delete the Wisp "Quill"',
          wisp: { action: "delete", name: "Quill" },
          expiresAt: "2026-10-11T12:01:00.000Z",
        }}
        wispName="Chief"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Delete Quill?")).toBeVisible();
    expect(screen.getByText(/This action cannot be undone/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onResolve).toHaveBeenLastCalledWith("deny");
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(onResolve).toHaveBeenLastCalledWith("allow_once");
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

  it("names the tool in words, never by its identifier", () => {
    const request = {
      approvalId: "approval-5",
      conversationId: "atlas",
      toolCallId: "tool-5",
      toolName: "mcp_ee86e536b696_getentry",
      category: "integration_call" as const,
      scope: { kind: "integration" as const, display: "Journal" },
      summary: "Get entry — id: 42",
      expiresAt: "2026-09-07T12:01:00.000Z",
    };
    const { rerender } = render(
      <ToolApprovalCard request={{ ...request, toolLabel: "Get entry" }} wispName="Atlas" onResolve={vi.fn()} />,
    );
    expect(screen.getByText(/Atlas requested Get entry for Journal/)).toBeVisible();
    expect(screen.queryByText(/mcp_ee86e536b696/)).not.toBeInTheDocument();

    // A server too old to send the label still gets words from the catalog or the name.
    rerender(
      <ToolApprovalCard
        request={{ ...request, toolName: "linear_update_issue", category: "external_write" }}
        wispName="Atlas"
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/Atlas requested Update Linear issue for Journal/)).toBeVisible();
  });

  it("names the button and the site of a browser action", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-browser",
          conversationId: "atlas",
          toolCallId: "tool-browser",
          toolName: "browser",
          category: "browser_submit",
          scope: { kind: "browser", display: "shop.example.com" },
          summary: "Click the button “Place order” on shop.example.com",
          expiresAt: "2026-09-07T12:01:00.000Z",
        }}
        wispName="Atlas"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Approve browser action?")).toBeVisible();
    expect(screen.getByText("Click the button “Place order” on shop.example.com")).toBeVisible();
    expect(screen.getByText(/act on your behalf, on that site/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Always allow/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onResolve).toHaveBeenCalledWith("allow_once");
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

  it("shows a memory change in full and allows it only once (ADR 029)", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <ToolApprovalCard
        request={{
          approvalId: "approval-4",
          conversationId: "atlas",
          toolCallId: "tool-4",
          toolName: "save_memory",
          category: "save_memory",
          scope: { kind: "memory", display: "About you and this Wisp" },
          summary: "2 memory changes",
          preview: "Add to About you: Prefers short answers.\nRemove from This Wisp: Old note.",
          expiresAt: "2026-09-07T12:01:00.000Z",
        }}
        wispName="Atlas"
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Save to memory?")).toBeVisible();
    expect(screen.getByLabelText("Memory changes")).toHaveTextContent(
      "Add to About you: Prefers short answers. Remove from This Wisp: Old note.",
    );
    expect(screen.getByText(/every Wisp sees what is about you/)).toBeVisible();
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

    expect(screen.getByText(/Atlas requested Write file for notes\.txt/)).toBeVisible();
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

  it("says what kinds of request it would allow", () => {
    const command: ToolApprovalRequest = {
      ...fileApproval("command"),
      category: "container_command",
      scope: { kind: "container", display: "container" },
    };
    const linear: ToolApprovalRequest = {
      ...fileApproval("linear"),
      category: "external_write",
      scope: { kind: "integration", display: "Linear" },
    };
    render(
      <AllowAllApprovals
        requests={[command, { ...command, approvalId: "second" }, fileApproval("one"), linear]}
        onAllow={vi.fn()}
      />,
    );

    expect(screen.getByText("2 commands, 1 file change, 1 integration call")).toBeVisible();
  });

  it("offers again what did not reach the backend", async () => {
    const user = userEvent.setup();
    const onAllow = vi.fn(async ({ approvalId }: ToolApprovalRequest) => approvalId === "three");
    render(
      <AllowAllApprovals
        requests={[fileApproval("one"), fileApproval("two"), fileApproval("three")]}
        onAllow={onAllow}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Allow all 3 once" }));

    expect(await screen.findByRole("button", { name: "Allow all 2 once" })).toBeVisible();
  });

  it("is not offered for a single approval", () => {
    render(<AllowAllApprovals requests={[fileApproval("one")]} onAllow={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();
  });
});
