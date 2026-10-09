import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { StorageSettingsSection } from "./storage-settings-section";

const MIB = 1024 * 1024;
const summary = {
  measuredAt: "2026-10-09T12:00:00.000Z",
  workspaces: [
    {
      conversationId: "a",
      name: "Atlas",
      kind: "wisp" as const,
      usedBytes: 460 * MIB,
      fileCount: 12,
      quotaBytes: 512 * MIB,
      partial: false,
    },
    {
      conversationId: "b",
      name: "Nova",
      kind: "wisp" as const,
      usedBytes: 2 * MIB,
      fileCount: 1,
      quotaBytes: 512 * MIB,
      partial: false,
    },
  ],
  workspaceBytes: 462 * MIB,
  archives: [{ id: "old-1", usedBytes: 3 * MIB, fileCount: 4, archivedAt: null, partial: false }],
  archiveBytes: 3 * MIB,
  partial: false,
};
const entry = (name: string, size: number, type: "file" | "directory" = "file") => ({
  name,
  path: name,
  type,
  size,
  fileCount: 1,
  modifiedAt: null,
  partial: false,
});

function install(overrides: Record<string, unknown> = {}) {
  const wisp = {
    getStorageSummary: vi.fn(async () => ({ ok: true as const, value: summary })),
    listStorageDirectory: vi.fn(async () => ({
      ok: true as const,
      value: { path: "", entries: [entry("cache.bin", 1000)], nextCursor: null },
    })),
    prepareStorageCleanup: vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [entry("cache.bin", 1000)],
        totalBytes: 1000,
        fileCount: 1,
        fingerprint: "fp",
        includesInbox: false,
      },
    })),
    cleanStorage: vi.fn(async () => ({
      ok: true as const,
      value: { removed: ["cache.bin"], failed: [], removedBytes: 1000 },
    })),
    deleteArchivedStorage: vi.fn(async () => ({ ok: true as const, value: { removed: ["old-1"], failed: [] } })),
    openWorkspaceFolder: vi.fn(async () => ({ ok: true as const, value: {} })),
    ...overrides,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: wisp });
  return wisp;
}

it("lists workspaces largest first with usage, and filters by search", async () => {
  const user = userEvent.setup();
  install();
  render(<StorageSettingsSection />);

  expect(await screen.findByText("Atlas")).toBeInTheDocument();
  expect(screen.getByText(/460 MiB of 512 MiB \(90%\)/)).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Atlas usage" })).toHaveAttribute("aria-valuenow", "90");
  expect(screen.getByText("462 MiB")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Search workspaces" }), "nov");
  expect(screen.queryByText("Atlas")).not.toBeInTheDocument();
  expect(screen.getByText("Nova")).toBeInTheDocument();
});

it("starts filtered to a workspace and can show all", async () => {
  const user = userEvent.setup();
  install();
  render(<StorageSettingsSection initialConversationId="b" />);
  expect(await screen.findByText("Nova")).toBeInTheDocument();
  expect(screen.queryByText("Atlas")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show all workspaces" }));
  expect(screen.getByText("Atlas")).toBeInTheDocument();
});

it("previews, then removes selected files only after explicit confirmation", async () => {
  const user = userEvent.setup();
  const wisp = install();
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Inspect Atlas" }));
  await user.click(await screen.findByRole("checkbox", { name: "Select cache.bin" }));
  await user.click(screen.getByRole("button", { name: "Clean 1 selected…" }));

  const preview = await screen.findByRole("group", { name: "Cleanup preview" });
  expect(wisp.prepareStorageCleanup).toHaveBeenCalledWith({ conversationId: "a", paths: ["cache.bin"] });
  expect(within(preview).getByText("1 item · 1 files · 1000 B")).toBeInTheDocument();
  expect(wisp.cleanStorage).not.toHaveBeenCalled();

  await user.click(within(preview).getByRole("button", { name: "Review permanent removal" }));
  await user.click(within(preview).getByRole("button", { name: "Remove permanently" }));

  expect(wisp.cleanStorage).toHaveBeenCalledWith({ conversationId: "a", paths: ["cache.bin"], fingerprint: "fp" });
  expect(await screen.findByText(/Removed 1 item/)).toBeInTheDocument();
});

it("reports partial failures instead of claiming success", async () => {
  const user = userEvent.setup();
  install({
    cleanStorage: vi.fn(async () => ({
      ok: true as const,
      value: { removed: [], failed: [{ path: "cache.bin", message: "Permission denied." }], removedBytes: 0 },
    })),
  });
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Inspect Atlas" }));
  await user.click(await screen.findByRole("checkbox", { name: "Select cache.bin" }));
  await user.click(screen.getByRole("button", { name: "Clean 1 selected…" }));
  await user.click(await screen.findByRole("button", { name: "Review permanent removal" }));
  await user.click(screen.getByRole("button", { name: "Remove permanently" }));
  expect(await screen.findByText(/Not removed: cache.bin \(Permission denied.\)/)).toBeInTheDocument();
});

it("deletes archives with a warning about what they contain", async () => {
  const user = userEvent.setup();
  const wisp = install();
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("checkbox", { name: "Select archive old-1" }));
  await user.click(screen.getByRole("button", { name: "Delete 1 permanently" }));
  expect(screen.getByText(/workspace, saved sessions and the Wisp's settings/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  expect(wisp.deleteArchivedStorage).toHaveBeenCalledWith({ ids: ["old-1"] });
});

it("explains when the server is too old", async () => {
  install({
    getStorageSummary: vi.fn(async () => ({
      ok: false as const,
      error: { code: "unsupported" as const, message: "x", retryable: false },
    })),
  });
  render(<StorageSettingsSection />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Update the server");
});
