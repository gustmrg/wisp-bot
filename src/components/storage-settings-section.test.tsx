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
      maxQuotaBytes: 2 * 1024 * MIB,
      folders: [
        { path: "inbox", type: "directory" as const, size: 400 * MIB, fileCount: 10 },
        { path: "notes.txt", type: "file" as const, size: 60 * MIB, fileCount: 1 },
      ],
      largestFiles: [{ path: "inbox/dataset.zip", size: 300 * MIB, modifiedAt: null }],
    },
    {
      conversationId: "b",
      name: "Nova",
      kind: "wisp" as const,
      usedBytes: 2 * MIB,
      fileCount: 1,
      quotaBytes: 512 * MIB,
      partial: false,
      maxQuotaBytes: 2 * 1024 * MIB,
      folders: [{ path: "papers", type: "directory" as const, size: 2 * MIB, fileCount: 1 }],
      largestFiles: [{ path: "papers/thesis.pdf", size: 2 * MIB, modifiedAt: null }],
    },
    {
      conversationId: "c",
      name: "Crew",
      kind: "circle" as const,
      usedBytes: 0,
      fileCount: 0,
      quotaBytes: 512 * MIB,
      partial: false,
      folders: [],
      largestFiles: [],
    },
  ],
  workspaceBytes: 462 * MIB,
  archives: [
    { id: "old-1", name: null, kind: null, usedBytes: 3 * MIB, fileCount: 4, archivedAt: null, partial: false },
    {
      id: "atlas-1",
      name: "Old Atlas",
      kind: "wisp" as const,
      usedBytes: 1 * MIB,
      fileCount: 2,
      archivedAt: "2026-10-01T10:00:00.000Z",
      partial: false,
    },
  ],
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

  expect(await screen.findByRole("button", { name: "Inspect Atlas" })).toBeInTheDocument();
  expect(screen.getByText(/460 MiB of 512 MiB \(90%\)/)).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Atlas usage" })).toHaveAttribute("aria-valuenow", "90");
  expect(screen.getByText("462 MiB")).toBeInTheDocument();
  expect(screen.getByText(/of 1.5 GiB allotted/)).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Search workspaces" }), "nov");
  expect(screen.queryByRole("button", { name: "Inspect Atlas" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Nova" })).toBeInTheDocument();
});

it("starts filtered to a workspace and can show all", async () => {
  const user = userEvent.setup();
  install();
  render(<StorageSettingsSection initialConversationId="b" />);
  expect(await screen.findByRole("button", { name: "Inspect Nova" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Atlas" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show all workspaces" }));
  expect(screen.getByRole("button", { name: "Inspect Atlas" })).toBeInTheDocument();
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
  // Archives are named after what was deleted; older ones fall back to their ID.
  expect(await screen.findByRole("checkbox", { name: "Select archive Old Atlas" })).toBeInTheDocument();
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

it("charts usage with the same numbers as the list and counts full workspaces", async () => {
  install();
  render(<StorageSettingsSection />);
  expect(await screen.findByRole("img", { name: "Space by workspace: Atlas 460 MiB, Nova 2.0 MiB" })).toBeVisible();
  expect(screen.getByText("0 workspaces")).toBeInTheDocument();
});

it("says when there is nothing stored yet", async () => {
  install({
    getStorageSummary: vi.fn(async () => ({
      ok: true as const,
      value: { ...summary, workspaces: [summary.workspaces[2]], workspaceBytes: 0 },
    })),
  });
  render(<StorageSettingsSection />);
  expect(await screen.findByText("No files in workspaces yet.")).toBeInTheDocument();
});

it("opens the largest file in the inspector, already selected", async () => {
  const user = userEvent.setup();
  const wisp = install();
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("radio", { name: "Files" }));
  const largest = within(screen.getByRole("region", { name: "Largest" }));
  expect(largest.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    expect.stringContaining("dataset.zip"),
    expect.stringContaining("thesis.pdf"),
  ]);
  await user.click(screen.getByRole("button", { name: "Show dataset.zip in Atlas › inbox" }));

  expect(wisp.listStorageDirectory).toHaveBeenCalledWith({ conversationId: "a", path: "inbox" });
  expect(await screen.findByRole("checkbox", { name: "Select inbox/dataset.zip" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Clean 1 selected…" })).toBeEnabled();
});

it("lists the largest folders across workspaces and opens one", async () => {
  const user = userEvent.setup();
  const wisp = install();
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("radio", { name: "Folders" }));
  // Files at a workspace's root are not folders.
  expect(screen.queryByText("notes.txt/")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open inbox/ in Atlas · 10 files" }));
  expect(wisp.listStorageDirectory).toHaveBeenCalledWith({ conversationId: "a", path: "inbox" });
  expect(
    await screen.findByRole("img", { name: /Space by folder: inbox\/ 400 MiB, notes.txt 60.0 MiB/ }),
  ).toBeVisible();
});

it("explains that an older server does not report folders and files", async () => {
  const user = userEvent.setup();
  install({
    getStorageSummary: vi.fn(async () => ({
      ok: true as const,
      value: {
        ...summary,
        workspaces: summary.workspaces.map(({ folders: _f, largestFiles: _l, maxQuotaBytes: _m, ...rest }) => rest),
      },
    })),
  });
  render(<StorageSettingsSection />);
  await user.click(await screen.findByRole("radio", { name: "Files" }));
  expect(screen.getByText(/does not report folders and files/)).toBeInTheDocument();
});

it("resizes a workspace from the list, confirming a size below its usage", async () => {
  const user = userEvent.setup();
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async ({ quotaBytes }: { quotaBytes: number }) => ({
    ok: true as const,
    value: { usedBytes: 460 * MIB, quotaBytes, maxQuotaBytes: 2 * GIB },
  }));
  install({ setWorkspaceQuota });
  render(<StorageSettingsSection />);

  const size = await screen.findByRole("combobox", { name: "Workspace size for Atlas" });
  await user.click(size);
  expect(screen.getByRole("option", { name: "10.0 GiB" })).toHaveAttribute("aria-disabled", "true");
  await user.click(await screen.findByRole("option", { name: "2.0 GiB" }));
  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "a", quotaBytes: 2 * GIB });
  expect(await screen.findByText(/460 MiB of 2.0 GiB \(22%\)/)).toBeInTheDocument();
  expect(screen.getByText(/of 3.0 GiB allotted/)).toBeInTheDocument();
});

it("asks before giving a workspace less room than it uses", async () => {
  const user = userEvent.setup();
  const GIB = 1024 * MIB;
  const setWorkspaceQuota = vi.fn(async () => ({
    ok: true as const,
    value: { usedBytes: GIB, quotaBytes: 512 * MIB, maxQuotaBytes: 2 * GIB },
  }));
  const [atlas, ...others] = summary.workspaces;
  install({
    setWorkspaceQuota,
    getStorageSummary: vi.fn(async () => ({
      ok: true as const,
      value: { ...summary, workspaces: [{ ...atlas!, usedBytes: GIB, quotaBytes: 2 * GIB }, ...others] },
    })),
  });
  render(<StorageSettingsSection />);

  await user.click(await screen.findByRole("combobox", { name: "Workspace size for Atlas" }));
  await user.click(await screen.findByRole("option", { name: "512 MiB" }));
  expect(setWorkspaceQuota).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Smaller than what it holds (1.0 GiB)");
  await user.click(screen.getByRole("button", { name: "Set to 512 MiB anyway" }));
  expect(setWorkspaceQuota).toHaveBeenCalledWith({ conversationId: "a", quotaBytes: 512 * MIB });
  // The list and the summary agree that it is now full.
  expect(await screen.findByText("1 workspace")).toBeInTheDocument();
  expect(screen.getByText(/1.0 GiB of 512 MiB \(200%\)/)).toBeInTheDocument();
});

it("keeps a circle's size fixed and reports servers that cannot resize", async () => {
  const user = userEvent.setup();
  install({
    setWorkspaceQuota: vi.fn(async () => ({
      ok: false as const,
      error: { code: "unsupported" as const, message: "x", retryable: false },
    })),
  });
  render(<StorageSettingsSection />);
  expect(await screen.findByText("Circles keep 512 MiB")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Workspace size for Crew" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("combobox", { name: "Workspace size for Nova" }));
  await user.click(await screen.findByRole("option", { name: "2.0 GiB" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cannot resize workspaces");
});
