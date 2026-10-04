import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { WispWorkspaceSettings } from "./wisp-workspace-settings";

it("loads usage lazily and opens the workspace and skills folders", async () => {
  const user = userEvent.setup();
  const getWorkspace = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: 5 * 1024 * 1024, quotaBytes: 512 * 1024 * 1024 },
  }));
  const openWorkspaceFolder = vi.fn(async () => ({ ok: true as const, value: {} }));
  const openSkillsFolder = vi.fn(async () => ({
    ok: false as const,
    error: { code: "internal_error" as const, message: "The folder could not be opened.", retryable: true },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getWorkspace, openWorkspaceFolder, openSkillsFolder },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  expect(getWorkspace).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Workspace" }));

  expect(await screen.findByText("5.0 MB of 512 MB used")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Workspace usage" })).toHaveAttribute("aria-valuenow", "1");
  await user.click(screen.getByRole("button", { name: "Open workspace folder" }));
  expect(openWorkspaceFolder).toHaveBeenCalledWith({ conversationId: "one" });
  await user.click(screen.getByRole("button", { name: "Open skills folder" }));
  expect(openSkillsFolder).toHaveBeenCalledWith({ conversationId: "one" });
  expect(await screen.findByRole("alert")).toHaveTextContent("The folder could not be opened.");
});
