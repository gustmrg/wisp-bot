import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StorageService } from "../backend/storage-service.js";
import { WorkspaceService } from "../backend/workspace-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(
  options: {
    busy?: Set<string>;
    quotaBytes?: number;
    onCleanupFinished?: (id: string) => void;
    resolveQuota?: (id: string, fallback: number) => Promise<number>;
    freeDiskBytes?: (directory: string) => Promise<number>;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-storage-"));
  directories.push(root);
  const atlas = path.join(root, "workspaces", "atlas");
  const circle = path.join(root, "workspaces", "circle");
  const archive = path.join(root, "deleted-conversations");
  await mkdir(path.join(atlas, "inbox"), { recursive: true });
  await mkdir(circle, { recursive: true });
  await mkdir(archive, { recursive: true });
  const folders = [
    { conversationId: "atlas", name: "Atlas", kind: "wisp" as const, directory: atlas },
    { conversationId: "circle", name: "Team", kind: "circle" as const, directory: circle },
    // A second conversation record pointing at the same folder must not be counted twice.
    { conversationId: "atlas-dup", name: "Atlas again", kind: "wisp" as const, directory: atlas },
  ];
  const service = new StorageService({
    listWorkspaces: () => folders,
    resolveWorkspace: (id) => {
      const found = folders.find((folder) => folder.conversationId === id);
      if (!found) throw new Error("unknown");
      return found.directory;
    },
    archiveDirectory: archive,
    isBusy: (id) => options.busy?.has(id) ?? false,
    ...(options.onCleanupFinished ? { onCleanupFinished: options.onCleanupFinished } : {}),
    ...(options.quotaBytes === undefined ? {} : { quotaBytes: options.quotaBytes }),
    ...(options.resolveQuota ? { resolveQuota: options.resolveQuota } : {}),
    freeDiskBytes: options.freeDiskBytes ?? (async () => 0),
  });
  return { root, atlas, circle, archive, service };
}

describe("StorageService summary", () => {
  it("measures each workspace once, largest first, and archives separately", async () => {
    const { atlas, circle, archive, service } = await setup();
    await writeFile(path.join(atlas, "inbox", "a.bin"), Buffer.alloc(100));
    await writeFile(path.join(atlas, "notes.txt"), Buffer.alloc(50));
    await writeFile(path.join(circle, "big.bin"), Buffer.alloc(400));
    await mkdir(path.join(archive, "old-1", "workspace"), { recursive: true });
    await writeFile(path.join(archive, "old-1", "workspace", "x"), Buffer.alloc(7));

    const summary = await service.getSummary();

    expect(
      summary.workspaces.map(({ conversationId, usedBytes, fileCount }) => [conversationId, usedBytes, fileCount]),
    ).toEqual([
      ["circle", 400, 1],
      ["atlas", 150, 2],
    ]);
    expect(summary.workspaceBytes).toBe(550);
    expect(summary.archives).toMatchObject([{ id: "old-1", usedBytes: 7, fileCount: 1, partial: false }]);
    expect(summary.archiveBytes).toBe(7);
    expect(summary.partial).toBe(false);
  });

  it("names archives from their manifest, and falls back to the folder for older ones", async () => {
    const { archive, service } = await setup();
    await mkdir(path.join(archive, "named-1"), { recursive: true });
    await writeFile(
      path.join(archive, "named-1", "archive.json"),
      JSON.stringify({ name: "Atlas", kind: "wisp", archivedAt: "2026-10-01T10:00:00.000Z" }),
    );
    await mkdir(path.join(archive, "old-1"), { recursive: true });
    await mkdir(path.join(archive, "broken-1"), { recursive: true });
    await writeFile(path.join(archive, "broken-1", "archive.json"), "{not json");

    const { archives } = await service.getSummary();
    const byId = Object.fromEntries(archives.map((entry) => [entry.id, entry]));
    expect(byId["named-1"]).toMatchObject({ name: "Atlas", kind: "wisp", archivedAt: "2026-10-01T10:00:00.000Z" });
    expect(byId["old-1"]).toMatchObject({ name: null, kind: null });
    expect(byId["old-1"]?.archivedAt).toEqual(expect.any(String));
    expect(byId["broken-1"]).toMatchObject({ name: null, kind: null });
  });

  it("reuses a recent measurement until refreshed", async () => {
    const { atlas, service } = await setup();
    await writeFile(path.join(atlas, "a"), Buffer.alloc(10));
    expect((await service.getSummary()).workspaceBytes).toBe(10);
    await writeFile(path.join(atlas, "b"), Buffer.alloc(10));
    expect((await service.getSummary()).workspaceBytes).toBe(10);
    expect((await service.getSummary({ refresh: true })).workspaceBytes).toBe(20);
  });

  it("marks unreadable folders as partial instead of zero", async () => {
    if (process.getuid?.() === 0) return;
    const { atlas, service } = await setup();
    const locked = path.join(atlas, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "f"), "x");
    const { chmod } = await import("node:fs/promises");
    await chmod(locked, 0o000);
    try {
      const summary = await service.getSummary();
      expect(summary.partial).toBe(true);
      expect(summary.workspaces.find(({ conversationId }) => conversationId === "atlas")?.partial).toBe(true);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("StorageService largest consumers", () => {
  it("reports each workspace's root entries and largest files, without counting a shared folder twice", async () => {
    const { atlas, service } = await setup();
    await writeFile(path.join(atlas, "inbox", "big.zip"), Buffer.alloc(300));
    await writeFile(path.join(atlas, "inbox", "small.txt"), Buffer.alloc(5));
    await mkdir(path.join(atlas, "papers", "drafts"), { recursive: true });
    await writeFile(path.join(atlas, "papers", "drafts", "thesis.pdf"), Buffer.alloc(120));
    await writeFile(path.join(atlas, "notes.txt"), Buffer.alloc(40));

    const { workspaces, workspaceBytes } = await service.getSummary();

    expect(workspaces.filter(({ name }) => name.startsWith("Atlas"))).toHaveLength(1);
    expect(workspaceBytes).toBe(465);
    const atlasSummary = workspaces.find(({ conversationId }) => conversationId === "atlas")!;
    expect(atlasSummary.folders).toEqual([
      { path: "inbox", type: "directory", size: 305, fileCount: 2 },
      { path: "papers", type: "directory", size: 120, fileCount: 1 },
      { path: "notes.txt", type: "file", size: 40, fileCount: 1 },
    ]);
    expect(atlasSummary.largestFiles?.map(({ path: filePath, size }) => [filePath, size])).toEqual([
      ["inbox/big.zip", 300],
      ["papers/drafts/thesis.pdf", 120],
      ["notes.txt", 40],
      ["inbox/small.txt", 5],
    ]);
    expect(atlasSummary.largestFiles?.[0]?.modifiedAt).toEqual(expect.any(String));
  });

  it("keeps only the largest files", async () => {
    const { circle, service } = await setup();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) => writeFile(path.join(circle, `f${index}`), Buffer.alloc(index + 1))),
    );
    const { workspaces } = await service.getSummary();
    const files = workspaces.find(({ conversationId }) => conversationId === "circle")!.largestFiles!;
    expect(files.map(({ size }) => size)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
  });

  it("offers Wisp workspaces the sizes the disk has room for, and none for circles", async () => {
    const MIB = 1024 * 1024;
    const { service } = await setup({ freeDiskBytes: async () => 3 * 1024 * MIB });
    const { workspaces } = await service.getSummary();
    expect(workspaces.find(({ conversationId }) => conversationId === "atlas")?.maxQuotaBytes).toBe(2 * 1024 * MIB);
    expect(workspaces.find(({ conversationId }) => conversationId === "circle")).not.toHaveProperty("maxQuotaBytes");
  });

  it("leaves the largest size out when the disk cannot be measured", async () => {
    const { service } = await setup({
      freeDiskBytes: async () => {
        throw new Error("statfs failed");
      },
    });
    const { workspaces } = await service.getSummary();
    expect(workspaces.find(({ conversationId }) => conversationId === "atlas")).not.toHaveProperty("maxQuotaBytes");
  });

  it("measures again after being invalidated", async () => {
    const { atlas, service } = await setup();
    expect((await service.getSummary()).workspaceBytes).toBe(0);
    await writeFile(path.join(atlas, "a"), Buffer.alloc(10));
    service.invalidate();
    expect((await service.getSummary()).workspaceBytes).toBe(10);
  });
});

describe("StorageService inspection", () => {
  it("lists a folder largest first with folder totals, and pages", async () => {
    const { atlas, service } = await setup();
    await writeFile(path.join(atlas, "small"), Buffer.alloc(1));
    await mkdir(path.join(atlas, "dir"));
    await writeFile(path.join(atlas, "dir", "one"), Buffer.alloc(30));
    await writeFile(path.join(atlas, "dir", "two"), Buffer.alloc(30));

    const page = await service.listDirectory({ conversationId: "atlas", path: "" });
    expect(page.entries.map(({ name, type, size, fileCount }) => [name, type, size, fileCount])).toEqual([
      ["dir", "directory", 60, 2],
      ["small", "file", 1, 1],
      ["inbox", "directory", 0, 0],
    ]);
    expect(page.nextCursor).toBeNull();
    expect((await service.listDirectory({ conversationId: "atlas", path: "dir" })).entries[0]?.path).toBe("dir/one");
  });

  it("pages large folders", async () => {
    const { atlas, service } = await setup();
    await Promise.all(Array.from({ length: 450 }, (_, index) => writeFile(path.join(atlas, `f${index}`), "x")));
    const first = await service.listDirectory({ conversationId: "atlas", path: "" });
    expect(first.entries).toHaveLength(200);
    const second = await service.listDirectory({ conversationId: "atlas", path: "", cursor: first.nextCursor! });
    const third = await service.listDirectory({ conversationId: "atlas", path: "", cursor: second.nextCursor! });
    expect(second.entries).toHaveLength(200);
    expect(third.entries.length).toBeGreaterThanOrEqual(50);
    expect(third.nextCursor).toBeNull();
  });

  it("rejects traversal, absolute paths and symlinked folders", async () => {
    const { root, atlas, service } = await setup();
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "outside", "secret"), "s");
    await symlink(path.join(root, "outside"), path.join(atlas, "escape"));
    for (const bad of ["..", "../circle", "/etc", "inbox/../..", "escape", "a//b", "./inbox", "a\\b"]) {
      await expect(service.listDirectory({ conversationId: "atlas", path: bad })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    await expect(service.listDirectory({ conversationId: "atlas", path: "escape/" })).rejects.toBeTruthy();
    const listing = await service.listDirectory({ conversationId: "atlas", path: "" });
    expect(listing.entries.find(({ name }) => name === "escape")).toMatchObject({ type: "link", size: 0 });
  });

  it("treats a missing workspace as empty", async () => {
    const { atlas, service } = await setup();
    await rm(atlas, { recursive: true });
    expect(await service.listDirectory({ conversationId: "atlas", path: "" })).toMatchObject({ entries: [] });
  });
});

describe("StorageService cleanup", () => {
  async function seeded() {
    const context = await setup();
    await writeFile(path.join(context.atlas, "inbox", "report.pdf"), Buffer.alloc(100));
    await writeFile(path.join(context.atlas, "cache.bin"), Buffer.alloc(40));
    await mkdir(path.join(context.atlas, "build"));
    await writeFile(path.join(context.atlas, "build", "out"), Buffer.alloc(10));
    return context;
  }

  it("previews, then deletes only the previewed paths", async () => {
    const { atlas, service } = await seeded();
    const preview = await service.prepareCleanup({
      conversationId: "atlas",
      paths: ["inbox/report.pdf", "build", "build/out"],
    });
    expect(preview).toMatchObject({ totalBytes: 110, fileCount: 2, includesInbox: true });
    expect(preview.items.map(({ path: itemPath }) => itemPath)).toEqual(["build", "inbox/report.pdf"]);
    await stat(path.join(atlas, "build", "out"));

    const result = await service.cleanup({
      conversationId: "atlas",
      paths: ["inbox/report.pdf", "build", "build/out"],
      fingerprint: preview.fingerprint,
    });

    expect(result).toEqual({ removed: ["build", "inbox/report.pdf"], failed: [], removedBytes: 110 });
    expect((await readdir(atlas)).sort()).toEqual(["cache.bin", "inbox"]);
    expect((await service.getSummary()).workspaceBytes).toBe(40);
  });

  it("asks for a new confirmation when the files changed after the preview", async () => {
    const { atlas, service } = await seeded();
    const request = { conversationId: "atlas", paths: ["cache.bin"] };
    const preview = await service.prepareCleanup(request);
    await writeFile(path.join(atlas, "cache.bin"), Buffer.alloc(41));
    await expect(service.cleanup({ ...request, fingerprint: preview.fingerprint })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await stat(path.join(atlas, "cache.bin"));
  });

  it("refuses the root, traversal and links, and never touches files outside", async () => {
    const { root, atlas, service } = await seeded();
    await writeFile(path.join(root, "outside.txt"), "keep");
    await symlink(path.join(root, "outside.txt"), path.join(atlas, "link"));
    await mkdir(path.join(root, "elsewhere"));
    await writeFile(path.join(root, "elsewhere", "f"), "keep");
    await symlink(path.join(root, "elsewhere"), path.join(atlas, "dirlink"));
    for (const bad of ["", ".", "..", "../circle", "/etc/passwd", "link", "dirlink/f"]) {
      await expect(service.prepareCleanup({ conversationId: "atlas", paths: [bad] })).rejects.toBeTruthy();
    }
    await expect(service.prepareCleanup({ conversationId: "atlas", paths: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await stat(path.join(root, "outside.txt"));
    await stat(path.join(root, "elsewhere", "f"));
  });

  it("does not follow a folder swapped for a symlink between preview and delete", async () => {
    const { root, atlas, service } = await seeded();
    await mkdir(path.join(root, "victim"));
    await writeFile(path.join(root, "victim", "out"), Buffer.alloc(10));
    const request = { conversationId: "atlas", paths: ["build/out"] };
    const preview = await service.prepareCleanup(request);
    await rm(path.join(atlas, "build"), { recursive: true });
    await symlink(path.join(root, "victim"), path.join(atlas, "build"));
    await expect(service.cleanup({ ...request, fingerprint: preview.fingerprint })).rejects.toBeTruthy();
    await stat(path.join(root, "victim", "out"));
  });

  it("is refused while the conversation is working, and while a file is being received", async () => {
    const busy = new Set<string>();
    const { atlas, service } = await setup({ busy });
    await writeFile(path.join(atlas, "cache.bin"), Buffer.alloc(5));
    const request = { conversationId: "atlas", paths: ["cache.bin"] };
    const { fingerprint } = await service.prepareCleanup(request);

    busy.add("atlas");
    await expect(service.cleanup({ ...request, fingerprint })).rejects.toMatchObject({ code: "unavailable" });
    busy.clear();

    const release = service.acquireWrite("atlas");
    await expect(service.cleanup({ ...request, fingerprint })).rejects.toMatchObject({ code: "unavailable" });
    release();
    await expect(service.cleanup({ ...request, fingerprint })).resolves.toMatchObject({ removed: ["cache.bin"] });
  });

  it("reports the cleanup while it runs, and signals when it ends", async () => {
    const finished = vi.fn();
    const { atlas, service } = await setup({ onCleanupFinished: finished });
    await writeFile(path.join(atlas, "cache.bin"), Buffer.alloc(5));
    const request = { conversationId: "atlas", paths: ["cache.bin"] };
    const { fingerprint } = await service.prepareCleanup(request);

    const running = service.cleanup({ ...request, fingerprint });
    // Agents check this before running: the lock is taken before the first await.
    expect(service.isCleaning("atlas")).toBe(true);
    expect(service.isCleaning("circle")).toBe(false);
    await running;
    expect(service.isCleaning("atlas")).toBe(false);
    expect(finished).toHaveBeenCalledWith("atlas");
  });

  it("reports each Wisp's own workspace size and the default for circles", async () => {
    const resolveQuota = vi.fn(async (id: string, fallback: number) => {
      if (id === "atlas-dup") throw new Error("unreadable");
      return id === "atlas" ? 4096 : fallback;
    });
    const { service } = await setup({ quotaBytes: 100, resolveQuota });

    const summary = await service.getSummary();

    expect(summary.workspaces.map(({ conversationId, quotaBytes }) => [conversationId, quotaBytes])).toEqual(
      expect.arrayContaining([
        ["atlas", 4096],
        ["circle", 100],
      ]),
    );
    expect(resolveQuota).not.toHaveBeenCalledWith("circle", expect.anything());
  });

  it("blocks uploads during a cleanup and frees quota afterwards", async () => {
    const { atlas, service } = await setup({ quotaBytes: 100 });
    const workspace = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory: atlas, configDirectory: path.join(atlas, "..", "cfg") }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      quotaBytes: 100,
      acquireWrite: (id) => service.acquireWrite(id),
    });
    const upload = (size: number) =>
      workspace.receive(
        "atlas",
        { name: "f.bin", size },
        (async function* () {
          yield new Uint8Array(size);
        })(),
      );
    await upload(80);
    await expect(upload(80)).rejects.toMatchObject({ code: "invalid_request" });
    const request = { conversationId: "atlas", paths: ["inbox/f.bin"] };
    const { fingerprint } = await service.prepareCleanup(request);
    await service.cleanup({ ...request, fingerprint });
    await expect(upload(80)).resolves.toMatchObject({ size: 80 });
  });

  it("refuses to confirm when a selected file disappeared after the preview", async () => {
    const { atlas, service } = await seeded();
    const request = { conversationId: "atlas", paths: ["cache.bin", "build"] };
    const { fingerprint } = await service.prepareCleanup(request);
    // Force a removal failure after validation by making cache.bin vanish just in time.
    const original = await import("node:fs/promises");
    await original.rm(path.join(atlas, "cache.bin"));
    await expect(service.cleanup({ ...request, fingerprint })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("StorageService archives", () => {
  it("deletes whole archives by id and rejects anything that is not one", async () => {
    const { root, archive, service } = await setup();
    await mkdir(path.join(archive, "old-1"));
    await writeFile(path.join(archive, "old-1", "f"), "x");
    await mkdir(path.join(archive, "old-2"));
    await writeFile(path.join(root, "keep"), "k");

    const result = await service.deleteArchives({ ids: ["old-1", "../keep", "missing", "old-1"] });

    expect(result.removed).toEqual(["old-1"]);
    expect(result.failed.map(({ id }) => id)).toEqual(["../keep", "missing"]);
    expect(await readdir(archive)).toEqual(["old-2"]);
    await stat(path.join(root, "keep"));
    await expect(service.deleteArchives({ ids: [] })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
