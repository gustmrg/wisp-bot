import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { WispWorkspaceSettings } from "./wisp-workspace-settings";

it("loads usage lazily and opens the workspace folder", async () => {
  const user = userEvent.setup();
  const getWorkspace = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: 5 * 1024 * 1024, quotaBytes: 512 * 1024 * 1024 },
  }));
  const openWorkspaceFolder = vi.fn(async () => ({
    ok: false as const,
    error: { code: "internal_error" as const, message: "The folder could not be opened.", retryable: true },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getWorkspace, openWorkspaceFolder },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  expect(getWorkspace).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Workspace" }));

  expect(await screen.findByText("5.0 MiB of 512 MiB used")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Workspace usage" })).toHaveAttribute("aria-valuenow", "1");
  await user.click(screen.getByRole("button", { name: "Open workspace folder" }));
  expect(openWorkspaceFolder).toHaveBeenCalledWith({ conversationId: "one" });
  expect(await screen.findByRole("alert")).toHaveTextContent("The folder could not be opened.");
});

it("links to the storage view, prominently when the workspace is nearly full", async () => {
  const user = userEvent.setup();
  const onOpenSettings = vi.fn();
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: { usedBytes: 500 * 1024 * 1024, quotaBytes: 512 * 1024 * 1024 },
      })),
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" onOpenSettings={onOpenSettings} />);
  await user.click(screen.getByRole("button", { name: "Workspace" }));
  await user.click(await screen.findByRole("button", { name: "Free up space" }));
  expect(onOpenSettings).toHaveBeenCalledWith({ section: "storage", conversationId: "one" });
});
