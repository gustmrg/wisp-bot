import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { SequencedConversationAgentEvent } from "../../shared/contracts";
import type { SkillView } from "../../shared/skills";
import { WispSkillSettings } from "./wisp-skill-settings";

const report: SkillView = {
  name: "weekly-report",
  description: "Builds the weekly report.",
  instructions: "1. Collect issues.",
  updatedAt: "2026-10-04T12:00:00.000Z",
};

it("lists skills lazily, refreshes after a save, and deletes after confirmation", async () => {
  const user = userEvent.setup();
  let listener: ((event: SequencedConversationAgentEvent) => void) | undefined;
  const listSkills = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: [] })
    .mockResolvedValueOnce({ ok: true, value: [report] });
  const deleteSkill = vi.fn(async () => ({ ok: true as const, value: [] }));
  const openSkillsFolder = vi.fn(async () => ({ ok: true as const, value: {} }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      listSkills,
      deleteSkill,
      openSkillsFolder,
      subscribeToAgentEvents: (next: typeof listener) => {
        listener = next;
        return () => undefined;
      },
    },
  });
  render(<WispSkillSettings conversationId="one" />);
  expect(listSkills).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Skills" }));
  expect(await screen.findByText("No skills yet.")).toBeInTheDocument();

  await act(async () => {
    listener?.({
      type: "tool_activity",
      conversationId: "one",
      requestId: "request",
      toolCallId: "tool",
      toolName: "save_skill",
      phase: "completed",
      sequence: 1,
    });
  });
  expect(await screen.findByText("weekly-report")).toBeInTheDocument();
  expect(screen.getByText("1. Collect issues.")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open skills folder" }));
  expect(openSkillsFolder).toHaveBeenCalledWith({ conversationId: "one" });

  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(deleteSkill).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete weekly-report" }));
  expect(deleteSkill).toHaveBeenCalledWith({ conversationId: "one", name: "weekly-report" });
  expect(await screen.findByText("No skills yet.")).toBeInTheDocument();
});

it("imports a picked SKILL.md and asks before replacing a skill with the same name", async () => {
  const user = userEvent.setup();
  const contents = "---\nname: weekly-report\ndescription: Builds the weekly report.\n---\n1. Collect issues.\n";
  const importSkill = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, value: [report] })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "already_exists", message: "A skill named weekly-report already exists.", retryable: false },
    })
    .mockResolvedValueOnce({ ok: true, value: [report] });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      listSkills: vi.fn(async () => ({ ok: true as const, value: [] })),
      importSkill,
      subscribeToAgentEvents: () => () => undefined,
    },
  });
  render(<WispSkillSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Skills" }));
  expect(await screen.findByText("No skills yet.")).toBeInTheDocument();

  const input = screen.getByLabelText("SKILL.md file");
  await user.upload(input, new File([contents], "SKILL.md", { type: "text/markdown" }));
  expect(importSkill).toHaveBeenLastCalledWith({ conversationId: "one", contents });
  expect(await screen.findByText("weekly-report")).toBeInTheDocument();

  await user.upload(input, new File([contents], "SKILL.md", { type: "text/markdown" }));
  expect(await screen.findByText(/already exists\. Replace it/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Replace skill" }));
  expect(importSkill).toHaveBeenLastCalledWith({ conversationId: "one", contents, replace: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Replace skill" })).not.toBeInTheDocument());

  await user.upload(input, new File(["x".repeat(64 * 1024 + 1)], "SKILL.md", { type: "text/markdown" }));
  expect(await screen.findByText("A skill file can be at most 64 KiB.")).toBeInTheDocument();
  expect(importSkill).toHaveBeenCalledTimes(3);
});
