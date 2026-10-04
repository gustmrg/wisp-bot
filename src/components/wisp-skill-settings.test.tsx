import { act, render, screen } from "@testing-library/react";
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
