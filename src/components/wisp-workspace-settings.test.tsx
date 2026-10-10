import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { WispWorkspaceSettings } from "./wisp-workspace-settings";

it("loads usage lazily and opens the workspace folder", async () => {
  const user = userEvent.setup();
  const getWorkspace = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: 5 * 1024 * 1024, quotaBytes: 512 * 1024 * 1024, maxQuotaBytes: 512 * 1024 * 1024 },
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
        value: { usedBytes: 500 * 1024 * 1024, quotaBytes: 512 * 1024 * 1024, maxQuotaBytes: 512 * 1024 * 1024 },
      })),
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" onOpenSettings={onOpenSettings} />);
  await user.click(screen.getByRole("button", { name: "Workspace" }));
  await user.click(await screen.findByRole("button", { name: "Free up space" }));
  expect(onOpenSettings).toHaveBeenCalledWith({ section: "storage", conversationId: "one" });
});

it("resizes the workspace, offering only sizes the disk has room for", async () => {
  const user = userEvent.setup();
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: 5 * MIB, quotaBytes: 10 * GIB, maxQuotaBytes: 10 * GIB },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: { usedBytes: 5 * MIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * GIB },
      })),
      setWorkspaceQuota,
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Workspace" }));

  const size = await screen.findByRole("combobox", { name: "Size" });
  expect(size).toHaveTextContent("512 MiB");
  await user.click(size);
  expect(screen.getByRole("option", { name: "50.0 GiB" })).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("option", { name: "10.0 GiB" }));

  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "one", quotaBytes: 10 * GIB });
  expect(await screen.findByText("5.0 MiB of 10.0 GiB used")).toBeInTheDocument();
});

it("asks before giving the workspace less room than it uses", async () => {
  const user = userEvent.setup();
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: GIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * GIB },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: { usedBytes: GIB, quotaBytes: 2 * GIB, maxQuotaBytes: 10 * GIB },
      })),
      setWorkspaceQuota,
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Workspace" }));
  await user.click(await screen.findByRole("combobox", { name: "Size" }));
  await user.click(screen.getByRole("option", { name: "512 MiB" }));

  expect(screen.getByRole("alert")).toHaveTextContent("until about 512 MiB is freed");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setWorkspaceQuota).not.toHaveBeenCalled();

  await user.click(screen.getByRole("combobox", { name: "Size" }));
  await user.click(await screen.findByRole("option", { name: "512 MiB" }));
  await user.click(screen.getByRole("button", { name: "Set to 512 MiB anyway" }));
  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "one", quotaBytes: 512 * MIB });
  expect(await screen.findByText("1.0 GiB of 512 MiB used")).toBeInTheDocument();
});
