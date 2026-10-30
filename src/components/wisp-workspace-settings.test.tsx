import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { WorkspaceView } from "../../shared/workspace";
import { WispWorkspaceSettings } from "./wisp-workspace-settings";

it("loads usage and opens the workspace folder", async () => {
  const user = userEvent.setup();
  const getWorkspace = vi.fn(async () => ({
    ok: true as const,
    value: {
      usedBytes: 5 * 1024 * 1024,
      quotaBytes: 512 * 1024 * 1024,
      maxQuotaBytes: 512 * 1024 * 1024,
      unlimited: false,
    },
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
        value: {
          usedBytes: 500 * 1024 * 1024,
          quotaBytes: 512 * 1024 * 1024,
          maxQuotaBytes: 512 * 1024 * 1024,
          unlimited: false,
        },
      })),
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" onOpenSettings={onOpenSettings} />);
  await user.click(await screen.findByRole("button", { name: "Free up space" }));
  expect(onOpenSettings).toHaveBeenCalledWith({ section: "storage", conversationId: "one" });
});

it("resizes the workspace, offering only sizes the disk has room for", async () => {
  const user = userEvent.setup();
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: 5 * MIB, quotaBytes: 10 * GIB, maxQuotaBytes: 10 * GIB, unlimited: false },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: { usedBytes: 5 * MIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * GIB, unlimited: false },
      })),
      setWorkspaceQuota,
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);

  const size = await screen.findByRole("combobox", { name: "Size" });
  expect(size).toHaveTextContent("512 MiB");
  await user.click(size);
  expect(await screen.findByRole("option", { name: "50.0 GiB" })).toHaveAttribute("aria-disabled", "true");
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
    value: { usedBytes: GIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * GIB, unlimited: false },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: { usedBytes: GIB, quotaBytes: 2 * GIB, maxQuotaBytes: 10 * GIB, unlimited: false },
      })),
      setWorkspaceQuota,
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  await user.click(await screen.findByRole("combobox", { name: "Size" }));
  await user.click(await screen.findByRole("option", { name: "512 MiB" }));

  expect(screen.getByRole("alert")).toHaveTextContent("until about 512 MiB is freed");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setWorkspaceQuota).not.toHaveBeenCalled();

  await user.click(screen.getByRole("combobox", { name: "Size" }));
  await user.click(await screen.findByRole("option", { name: "512 MiB" }));
  await user.click(screen.getByRole("button", { name: "Set to 512 MiB anyway" }));
  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "one", quotaBytes: 512 * MIB });
  expect(await screen.findByText("1.0 GiB of 512 MiB used")).toBeInTheDocument();
});

it("offers the preset sizes, 1 GiB among them, and Unlimited", async () => {
  const user = userEvent.setup();
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const view: WorkspaceView = { usedBytes: 5 * MIB, quotaBytes: 512 * MIB, maxQuotaBytes: 10 * GIB, unlimited: false };
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({ ok: true as const, value: view })),
      setWorkspaceQuota: vi.fn(),
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  await user.click(await screen.findByRole("combobox", { name: "Size" }));
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
    "64.0 MiB",
    "128 MiB",
    "256 MiB",
    "512 MiB",
    "1.0 GiB",
    "2.0 GiB",
    "10.0 GiB",
    "50.0 GiB",
    "100 GiB",
    "Unlimited",
  ]);
});

it("asks before removing the limit, then shows usage and the disk's free space without a bar", async () => {
  const user = userEvent.setup();
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async () => ({
    ok: true as const,
    value: {
      usedBytes: 5 * MIB,
      quotaBytes: 19 * GIB,
      maxQuotaBytes: 10 * GIB,
      unlimited: true,
      freeDiskBytes: 20 * GIB,
    },
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: {
          usedBytes: 5 * MIB,
          quotaBytes: 512 * MIB,
          maxQuotaBytes: 10 * GIB,
          unlimited: false,
          freeDiskBytes: 20 * GIB,
        },
      })),
      setWorkspaceQuota,
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" />);
  await user.click(await screen.findByRole("combobox", { name: "Size" }));
  await user.click(await screen.findByRole("option", { name: "Unlimited" }));

  expect(screen.getByRole("alert")).toHaveTextContent("until its disk has 1.0 GiB left (20.0 GiB free now)");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setWorkspaceQuota).not.toHaveBeenCalled();

  await user.click(screen.getByRole("combobox", { name: "Size" }));
  await user.click(await screen.findByRole("option", { name: "Unlimited" }));
  await user.click(screen.getByRole("button", { name: "Remove the limit" }));
  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "one", quotaBytes: null });
  expect(await screen.findByText("5.0 MiB used · 20.0 GiB free on disk")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Size" })).toHaveTextContent("Unlimited");
  expect(screen.getByText("No size limit. New files stop when its disk has 1.0 GiB left.")).toBeInTheDocument();
});

it("asks to free space on the disk once a workspace without a size has filled it to the reserve", async () => {
  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getWorkspace: vi.fn(async () => ({
        ok: true as const,
        value: {
          usedBytes: 90 * GIB,
          quotaBytes: 90 * GIB,
          maxQuotaBytes: 50 * GIB,
          unlimited: true,
          freeDiskBytes: 512 * MIB,
        },
      })),
      openWorkspaceFolder: vi.fn(),
    },
  });
  render(<WispWorkspaceSettings conversationId="one" onOpenSettings={vi.fn()} />);
  expect(await screen.findByText(/Its disk is almost full/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Free up space" })).toBeInTheDocument();
});
