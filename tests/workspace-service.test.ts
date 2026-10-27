import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertWorkspaceCapacity,
  largestQuota,
  listWorkspaceFiles,
  measureDirectory,
  readWorkspaceQuota,
  readWorkspaceSizeSetting,
  safeFileName,
  WORKSPACE_SETTINGS_FILE,
  WorkspaceService,
} from "../backend/workspace-service.js";
import {
  formatBytes,
  messagePreview,
  messageWithAttachments,
  splitMessageAttachments,
  WORKSPACE_DISK_RESERVE_BYTES,
  WORKSPACE_QUOTA_BYTES,
  WORKSPACE_QUOTA_PRESETS,
  workspaceUsage,
} from "../shared/workspace.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(selected: string[] = [], quotaBytes?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-workspace-"));
  directories.push(root);
  const workspaceDirectory = path.join(root, "workspaces", "session");
  const configDirectory = path.join(root, "wisp-config", "session");
  const picks = path.join(root, "picks");
  await mkdir(workspaceDirectory, { recursive: true });
  await mkdir(picks);
  const openPath = vi.fn(async (_directory: string) => undefined);
  const selectFiles = vi.fn(async () => selected.map((name) => path.join(picks, name)));
  const resolveDirectories = vi.fn((id: string) => {
    if (id !== "atlas") throw new Error("unknown");
    return { workspaceDirectory, configDirectory };
  });
  const service = new WorkspaceService({
    resolveDirectories,
    openPath,
    selectFiles,
    ...(quotaBytes === undefined ? {} : { quotaBytes }),
  });
  return { root, workspaceDirectory, configDirectory, picks, openPath, selectFiles, service };
}

describe("WorkspaceService", () => {
  it("opens the workspace and creates the skills folder outside it on first use", async () => {
    const { service, openPath, workspaceDirectory, configDirectory } = await setup();

    await service.openWorkspace("atlas");
    await service.openSkills("atlas");

    expect(openPath.mock.calls).toEqual([[workspaceDirectory], [path.join(configDirectory, "skills")]]);
    expect((await readFile(path.join(configDirectory, "skills"), "utf8").catch((error) => error.code)) as string).toBe(
      "EISDIR",
    );
    await expect(service.openSkills("other")).rejects.toThrow();
  });

  it("opens any conversation's workspace, circles included, when it can resolve one", async () => {
    const { root, openPath } = await setup();
    const circleWorkspace = path.join(root, "workspaces", "crew");
    const service = new WorkspaceService({
      // Circles have no agent context, so the Wisp-only resolver throws for them.
      resolveDirectories: () => {
        throw new Error("not a Wisp");
      },
      resolveWorkspace: (id) => {
        if (id !== "crew") throw new Error("unknown");
        return { workspaceDirectory: circleWorkspace, settingsDirectory: path.join(root, "circle-config", "crew") };
      },
      openPath,
      selectFiles: async () => [],
    });

    await service.openWorkspace("crew");

    expect(openPath).toHaveBeenCalledWith(circleWorkspace);
    expect((await stat(circleWorkspace)).isDirectory()).toBe(true);
  });

  it("measures, resizes and fills a circle's workspace by the circle's own size", async () => {
    const { root, picks } = await setup(["big.bin"]);
    const workspaceDirectory = path.join(root, "workspaces", "crew");
    const settingsDirectory = path.join(root, "circle-config", "crew");
    await mkdir(workspaceDirectory, { recursive: true });
    const [smallest] = WORKSPACE_QUOTA_PRESETS as [number];
    const larger = WORKSPACE_QUOTA_PRESETS[WORKSPACE_QUOTA_PRESETS.indexOf(WORKSPACE_QUOTA_BYTES) + 1]!;
    const service = new WorkspaceService({
      resolveDirectories: () => {
        throw new Error("not a Wisp");
      },
      resolveWorkspace: (id) => {
        if (id !== "crew") throw new Error("unknown");
        return { workspaceDirectory, settingsDirectory };
      },
      openPath: async () => undefined,
      selectFiles: async () => [path.join(picks, "big.bin")],
      freeDiskBytes: async () => larger,
    });

    await expect(service.getView("crew")).resolves.toMatchObject({
      usedBytes: 0,
      quotaBytes: WORKSPACE_QUOTA_BYTES,
      maxQuotaBytes: larger,
    });
    // The circle's settings folder does not exist until its first resize.
    await expect(service.setQuota("crew", larger)).resolves.toMatchObject({ quotaBytes: larger });
    expect(await readWorkspaceQuota(settingsDirectory)).toBe(larger);

    await service.setQuota("crew", smallest);
    await writeFile(path.join(picks, "big.bin"), Buffer.alloc(0));
    await truncate(path.join(picks, "big.bin"), smallest + 1);
    await expect(service.attach("crew")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("This workspace is full"),
    });
  });

  it("imports a picked SKILL.md and replaces an existing skill only when asked", async () => {
    const { service, configDirectory } = await setup();
    const contents = "---\nname: gh-flow\ndescription: Opens pull requests.\n---\n1. Branch.\n";

    await expect(service.importSkill({ conversationId: "atlas", contents })).resolves.toEqual([
      expect.objectContaining({ name: "gh-flow", instructions: "1. Branch." }),
    ]);
    expect(await readFile(path.join(configDirectory, "skills", "gh-flow", "SKILL.md"), "utf8")).toBe(contents);

    const updated = contents.replace("1. Branch.", "1. Fork.");
    await expect(service.importSkill({ conversationId: "atlas", contents: updated })).rejects.toMatchObject({
      code: "already_exists",
      message: "A skill named gh-flow already exists.",
    });
    await expect(service.importSkill({ conversationId: "atlas", contents: updated, replace: true })).resolves.toEqual([
      expect.objectContaining({ instructions: "1. Fork." }),
    ]);
    await expect(service.importSkill({ conversationId: "atlas", contents: "# no frontmatter" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("copies picked files into the inbox without replacing existing ones", async () => {
    const { service, picks, workspaceDirectory } = await setup(["notes.txt", "data.csv"]);
    await writeFile(path.join(picks, "notes.txt"), "hello", "utf8");
    await writeFile(path.join(picks, "data.csv"), "a,b", "utf8");
    await mkdir(path.join(workspaceDirectory, "inbox"));
    await writeFile(path.join(workspaceDirectory, "inbox", "notes.txt"), "older", "utf8");

    const result = await service.attach("atlas");

    expect(result.files).toEqual([
      { name: "notes (2).txt", path: "inbox/notes (2).txt", size: 5 },
      { name: "data.csv", path: "inbox/data.csv", size: 3 },
    ]);
    expect(await readFile(path.join(workspaceDirectory, "inbox", "notes.txt"), "utf8")).toBe("older");
    expect(await readFile(path.join(workspaceDirectory, "inbox", "notes (2).txt"), "utf8")).toBe("hello");
    expect(result.workspace.usedBytes).toBe(13);
  });

  it("resizes a Wisp's workspace and keeps the size in its config directory", async () => {
    const { service, configDirectory } = await setup();
    const larger = WORKSPACE_QUOTA_PRESETS[WORKSPACE_QUOTA_PRESETS.indexOf(WORKSPACE_QUOTA_BYTES) + 1]!;

    const before = await service.getView("atlas");
    expect(before).toMatchObject({ usedBytes: 0, quotaBytes: WORKSPACE_QUOTA_BYTES });
    expect(before.maxQuotaBytes).toBeGreaterThanOrEqual(WORKSPACE_QUOTA_BYTES);

    await expect(service.setQuota("atlas", larger)).resolves.toMatchObject({ quotaBytes: larger });
    expect(await readWorkspaceQuota(configDirectory)).toBe(larger);
    await expect(service.getView("atlas")).resolves.toMatchObject({ quotaBytes: larger });

    await expect(service.setQuota("atlas", larger + 1)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.setQuota("other", larger)).rejects.toThrow();
  });

  it("refuses to grow past the free disk space but always allows shrinking", async () => {
    const { configDirectory, workspaceDirectory } = await setup();
    // Sizes above the default, which a new workspace starts with.
    const [second, third] = WORKSPACE_QUOTA_PRESETS.filter((size) => size > WORKSPACE_QUOTA_BYTES) as [number, number];
    const [smallest] = WORKSPACE_QUOTA_PRESETS as [number];
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      freeDiskBytes: async () => second,
    });

    await expect(service.getView("atlas")).resolves.toMatchObject({ maxQuotaBytes: second });
    await expect(service.setQuota("atlas", third)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("does not have room"),
    });
    await expect(service.setQuota("atlas", second)).resolves.toMatchObject({ quotaBytes: second });
    await expect(service.setQuota("atlas", smallest)).resolves.toMatchObject({ quotaBytes: smallest });
  });

  it("offers sizes below the default and measures room for a Wisp not created yet", async () => {
    const { configDirectory, workspaceDirectory, root } = await setup();
    const [smallest] = WORKSPACE_QUOTA_PRESETS as [number];
    expect(smallest).toBeLessThan(WORKSPACE_QUOTA_BYTES);
    const measured: string[] = [];
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      freeDiskBytes: async (directory) => {
        measured.push(directory);
        return WORKSPACE_QUOTA_BYTES;
      },
      workspaceRoot: path.join(root, "workspaces"),
    });

    await expect(service.newWorkspaceRoom()).resolves.toBe(WORKSPACE_QUOTA_BYTES);
    expect(measured).toEqual([path.join(root, "workspaces")]);
    await expect(service.setQuota("atlas", smallest)).resolves.toMatchObject({ quotaBytes: smallest });
    expect(await readWorkspaceQuota(configDirectory)).toBe(smallest);
  });

  it("reports a resize only once it is saved", async () => {
    const { configDirectory, workspaceDirectory } = await setup();
    const [second, third] = WORKSPACE_QUOTA_PRESETS.filter((size) => size > WORKSPACE_QUOTA_BYTES) as [number, number];
    const onQuotaChanged = vi.fn();
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      freeDiskBytes: async () => second,
      onQuotaChanged,
    });

    await expect(service.setQuota("atlas", third)).rejects.toBeTruthy();
    expect(onQuotaChanged).not.toHaveBeenCalled();
    await service.setQuota("atlas", second);
    expect(onQuotaChanged).toHaveBeenCalledWith("atlas");
  });

  it("enforces a resized workspace's size on attachments", async () => {
    const { service, picks, configDirectory } = await setup(["big.bin"], 1024);
    await writeFile(path.join(picks, "big.bin"), "x".repeat(10), "utf8");
    // A saved size wins over the default the service was given.
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), JSON.stringify({ quotaBytes: 8 }), "utf8");

    await expect(service.attach("atlas")).rejects.toMatchObject({ message: expect.stringContaining("of 8 B used") });
  });

  it("offers 1 GiB between 512 MiB and 2 GiB", async () => {
    const { configDirectory, workspaceDirectory } = await setup();
    expect(WORKSPACE_QUOTA_PRESETS.slice(WORKSPACE_QUOTA_PRESETS.indexOf(WORKSPACE_QUOTA_BYTES), -3)).toEqual([
      512 * MIB,
      GIB,
      2 * GIB,
    ]);
    expect(formatBytes(GIB)).toBe("1.0 GiB");
    expect(largestQuota(1.5 * GIB)).toBe(GIB);
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      freeDiskBytes: async () => 1.5 * GIB,
    });

    await expect(service.getView("atlas")).resolves.toMatchObject({ maxQuotaBytes: GIB });
    await expect(service.setQuota("atlas", GIB)).resolves.toMatchObject({ quotaBytes: GIB, unlimited: false });
    await expect(service.setQuota("atlas", 2 * GIB)).rejects.toMatchObject({
      message: expect.stringContaining("does not have room"),
    });
  });

  it("gives a workspace no size, keeping the last one for older builds and still measuring it", async () => {
    const { configDirectory, workspaceDirectory, picks } = await setup();
    await writeFile(path.join(picks, "notes.txt"), "0123456789");
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [path.join(picks, "notes.txt")],
      quotaBytes: 8,
      freeDiskBytes: async () => 10 * GIB,
    });
    await expect(service.attach("atlas")).rejects.toMatchObject({ message: expect.stringContaining("of 8 B used") });

    await expect(service.setQuota("atlas", null)).resolves.toMatchObject({
      unlimited: true,
      freeDiskBytes: 10 * GIB,
      quotaBytes: 10 * GIB - WORKSPACE_DISK_RESERVE_BYTES,
    });
    expect(JSON.parse(await readFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), "utf8"))).toEqual({
      quotaBytes: 8,
      unlimited: true,
    });
    expect(await readWorkspaceQuota(configDirectory)).toBeNull();

    // Past the size it had, files still fit, and what the workspace holds is still measured.
    const { workspace } = await service.attach("atlas");
    expect(workspace).toMatchObject({ usedBytes: 10, unlimited: true, quotaBytes: 10 + 10 * GIB - GIB });
    expect(workspaceUsage(workspace)).toEqual({ share: null, percent: null, nearlyFull: false, full: false });
  });

  it("stops new files in a workspace without a size once its disk is down to the reserve", async () => {
    const { configDirectory, workspaceDirectory, picks } = await setup();
    await writeFile(path.join(picks, "notes.txt"), "0123456789");
    let free = WORKSPACE_DISK_RESERVE_BYTES + 100;
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [path.join(picks, "notes.txt")],
      freeDiskBytes: async () => free,
    });
    await service.setQuota("atlas", null);

    await expect(service.attach("atlas")).resolves.toMatchObject({ files: [expect.objectContaining({ size: 10 })] });
    free = WORKSPACE_DISK_RESERVE_BYTES + 5;
    await expect(service.attach("atlas")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("its disk is almost full"),
    });
    await expect(
      service.receive("atlas", { name: "more.txt", size: 10 }, (async function* () {})()),
    ).rejects.toMatchObject({ message: expect.stringContaining("Wisp keeps 1.0 GiB free") });
    await expect(service.getView("atlas")).resolves.toMatchObject({ usedBytes: 10, unlimited: true });
    expect(workspaceUsage(await service.getView("atlas"))).toMatchObject({ full: false, percent: null });
    free = WORKSPACE_DISK_RESERVE_BYTES;
    expect(workspaceUsage(await service.getView("atlas"))).toMatchObject({ full: true, nearlyFull: true });
  });

  it("checks a workspace without a size against the disk only, without measuring it", async () => {
    const { workspaceDirectory } = await setup();
    await chmod(workspaceDirectory, 0o000);
    try {
      // Measuring the unreadable folder would throw; the disk check never reads it.
      await expect(assertWorkspaceCapacity(workspaceDirectory, 10, null, async () => 2 * GIB)).resolves.toBeUndefined();
      await expect(assertWorkspaceCapacity(workspaceDirectory, 10, null, async () => GIB)).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await chmod(workspaceDirectory, 0o700);
    }
  });

  it("gives a workspace without a size a size again, needing disk room only to grow past what it holds", async () => {
    const { configDirectory, workspaceDirectory } = await setup();
    const [smallest] = WORKSPACE_QUOTA_PRESETS as [number];
    const service = new WorkspaceService({
      resolveDirectories: () => ({ workspaceDirectory, configDirectory }),
      openPath: async () => undefined,
      selectFiles: async () => [],
      freeDiskBytes: async () => 3 * GIB,
    });
    await service.setQuota("atlas", null);

    await expect(service.setQuota("atlas", 10 * GIB)).rejects.toMatchObject({
      message: expect.stringContaining("does not have room"),
    });
    await expect(service.setQuota("atlas", smallest)).resolves.toMatchObject({
      quotaBytes: smallest,
      unlimited: false,
    });
    expect(JSON.parse(await readFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), "utf8"))).toEqual({
      quotaBytes: smallest,
    });
    await expect(readWorkspaceSizeSetting(configDirectory)).resolves.toEqual({
      quotaBytes: smallest,
      unlimited: false,
    });
  });

  it("reports a damaged size setting instead of falling back to the default", async () => {
    const { configDirectory } = await setup();
    await expect(readWorkspaceQuota(configDirectory)).resolves.toBe(WORKSPACE_QUOTA_BYTES);
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), "{", "utf8");
    await expect(readWorkspaceQuota(configDirectory)).rejects.toMatchObject({ code: "internal_error" });
    await writeFile(
      path.join(configDirectory, WORKSPACE_SETTINGS_FILE),
      JSON.stringify({ quotaBytes: WORKSPACE_QUOTA_BYTES, unlimited: "yes" }),
      "utf8",
    );
    await expect(readWorkspaceQuota(configDirectory)).rejects.toMatchObject({ code: "internal_error" });
    // Without the size older builds apply, the setting is damaged even when it asks for none.
    await writeFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), JSON.stringify({ unlimited: true }), "utf8");
    await expect(readWorkspaceQuota(configDirectory)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("finds workspace files by name first, then by path, shallowest first", async () => {
    const { service, workspaceDirectory } = await setup();
    await mkdir(path.join(workspaceDirectory, "docs", "plans"), { recursive: true });
    await writeFile(path.join(workspaceDirectory, "notes.md"), "");
    await writeFile(path.join(workspaceDirectory, "docs", "plans", "launch.md"), "");
    await writeFile(path.join(workspaceDirectory, "docs", "plan.md"), "");

    expect(await service.searchFiles({ conversationId: "atlas", query: "" })).toEqual({
      paths: ["notes.md", "docs/plan.md", "docs/plans/launch.md"],
      empty: false,
    });
    expect((await service.searchFiles({ conversationId: "atlas", query: "PLAN" })).paths).toEqual([
      "docs/plan.md",
      "docs/plans/launch.md",
    ]);
    expect(await service.searchFiles({ conversationId: "atlas", query: "zz" })).toEqual({ paths: [], empty: false });
  });

  it("leaves out what Git ignores, repository history, packages and symlinks", async () => {
    const { workspaceDirectory, root } = await setup();
    const app = path.join(workspaceDirectory, "app");
    await mkdir(path.join(app, ".git", "info"), { recursive: true });
    await mkdir(path.join(app, "dist"), { recursive: true });
    await mkdir(path.join(app, "src"), { recursive: true });
    await mkdir(path.join(workspaceDirectory, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(workspaceDirectory, ".gitignore"), "*.log\n");
    await writeFile(path.join(app, ".gitignore"), "dist/\n*.tmp\n!keep.log\n");
    await writeFile(path.join(app, ".git", "info", "exclude"), "secret.txt\n");
    await writeFile(path.join(app, ".git", "HEAD"), "");
    for (const file of ["src/index.ts", "src/cache.tmp", "dist/index.js", "secret.txt", "debug.log", "keep.log"]) {
      await writeFile(path.join(app, file), "");
    }
    await writeFile(path.join(workspaceDirectory, "server.log"), "");
    await writeFile(path.join(workspaceDirectory, "node_modules", "left-pad", "index.js"), "");
    await writeFile(path.join(root, "outside.txt"), "");
    await symlink(path.join(root, "outside.txt"), path.join(workspaceDirectory, "outside.txt"));

    expect(await listWorkspaceFiles(workspaceDirectory)).toEqual([
      ".gitignore",
      "app/.gitignore",
      "app/keep.log",
      "app/src/index.ts",
    ]);
  });

  it("reads the workspace once while a query is typed, and again a few seconds later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service, workspaceDirectory } = await setup();
      await writeFile(path.join(workspaceDirectory, "first.md"), "");
      expect((await service.searchFiles({ conversationId: "atlas", query: "" })).paths).toEqual(["first.md"]);

      await writeFile(path.join(workspaceDirectory, "second.md"), "");
      expect((await service.searchFiles({ conversationId: "atlas", query: "sec" })).paths).toEqual([]);
      vi.advanceTimersByTime(6_000);
      expect((await service.searchFiles({ conversationId: "atlas", query: "sec" })).paths).toEqual(["second.md"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a workspace with no files, even one not created yet", async () => {
    const { service, workspaceDirectory } = await setup();
    await rm(workspaceDirectory, { recursive: true });

    expect(await service.searchFiles({ conversationId: "atlas", query: "" })).toEqual({ paths: [], empty: true });
  });

  it("returns no files when the picker is dismissed", async () => {
    const { service } = await setup();
    await expect(service.attach("atlas")).resolves.toMatchObject({ files: [], workspace: { usedBytes: 0 } });
  });

  it("rejects attachments that would exceed the quota and copies nothing", async () => {
    const { service, picks, workspaceDirectory } = await setup(["big.bin"], 10);
    await writeFile(path.join(picks, "big.bin"), "x".repeat(8), "utf8");
    await writeFile(path.join(workspaceDirectory, "existing.txt"), "1234", "utf8");

    await expect(service.attach("atlas")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("workspace is full"),
    });
    expect(await measureDirectory(workspaceDirectory)).toBe(4);
  });

  it("rejects folders and too many files", async () => {
    const folder = await setup(["folder"]);
    await mkdir(path.join(folder.picks, "folder"));
    await expect(folder.service.attach("atlas")).rejects.toMatchObject({ code: "invalid_request" });

    const many = await setup(Array.from({ length: 21 }, (_, index) => `${index}.txt`));
    await expect(many.service.attach("atlas")).rejects.toMatchObject({
      message: expect.stringContaining("at most 20"),
    });
  });
});

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

describe("WorkspaceService.receive", () => {
  it("stores a streamed file in the inbox without replacing existing ones", async () => {
    const { service, workspaceDirectory } = await setup();
    await mkdir(path.join(workspaceDirectory, "inbox"));
    await writeFile(path.join(workspaceDirectory, "inbox", "notes.txt"), "older", "utf8");

    await expect(service.receive("atlas", { name: "notes.txt", size: 11 }, chunks("hello", " world"))).resolves.toEqual(
      { name: "notes (2).txt", path: "inbox/notes (2).txt", size: 11 },
    );
    await expect(service.receive("atlas", { name: "../evil", size: 1 }, chunks("x"))).resolves.toMatchObject({
      path: "inbox/_evil",
    });
    expect(await readFile(path.join(workspaceDirectory, "inbox", "notes (2).txt"), "utf8")).toBe("hello world");
    expect((await readdir(path.join(workspaceDirectory, "inbox"))).sort()).toEqual([
      "_evil",
      "notes (2).txt",
      "notes.txt",
    ]);
  });

  it("keeps nothing from a file that arrived shorter or longer than declared", async () => {
    const { service, workspaceDirectory } = await setup();
    for (const [size, parts] of [
      [10, ["short"]],
      [3, ["too", " long"]],
    ] as const) {
      await expect(service.receive("atlas", { name: "a.txt", size }, chunks(...parts))).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("did not arrive complete"),
      });
    }
    expect(await readdir(path.join(workspaceDirectory, "inbox"))).toEqual([]);
  });

  it("refuses a file that would exceed the quota before reading it", async () => {
    const { service, workspaceDirectory } = await setup([], 10);
    await writeFile(path.join(workspaceDirectory, "existing.txt"), "1234", "utf8");
    await expect(service.receive("atlas", { name: "big.bin", size: 8 }, chunks("x".repeat(8)))).rejects.toMatchObject({
      message: expect.stringContaining("workspace is full"),
    });
    expect(await measureDirectory(workspaceDirectory)).toBe(4);
  });
});

describe("measureDirectory", () => {
  it("counts nested regular files but not symlink targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wisp-measure-"));
    directories.push(root);
    const outside = path.join(root, "outside.txt");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(outside, "x".repeat(100), "utf8");
    await writeFile(path.join(workspace, "nested", "a.txt"), "abc", "utf8");
    await symlink(outside, path.join(workspace, "link.txt"));

    expect(await measureDirectory(workspace)).toBe(3);
    expect(await measureDirectory(path.join(root, "missing"))).toBe(0);
  });

  it("counts a file hard-linked in several places once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wisp-measure-"));
    directories.push(root);
    const store = path.join(root, ".home", "store");
    const project = path.join(root, "project", "node_modules");
    await mkdir(store, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(path.join(store, "pkg"), "x".repeat(100), "utf8");
    await link(path.join(store, "pkg"), path.join(project, "pkg"));
    await link(path.join(store, "pkg"), path.join(store, "pkg-bin"));
    await writeFile(path.join(project, "own.txt"), "abc", "utf8");

    expect(await measureDirectory(root)).toBe(103);
  });

  it("refuses to report a lower bound when part of the folder cannot be read", async () => {
    if (process.getuid?.() === 0) return;
    const root = await mkdtemp(path.join(os.tmpdir(), "wisp-measure-"));
    directories.push(root);
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "f"), "x");
    await chmod(locked, 0o000);
    try {
      await expect(measureDirectory(root)).rejects.toMatchObject({ code: "internal_error" });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("workspaceUsage", () => {
  it("shows a sized workspace's share, nearly full from 90% and full at its size", () => {
    expect(workspaceUsage({ usedBytes: 0, quotaBytes: GIB })).toEqual({
      share: 0,
      percent: 0,
      nearlyFull: false,
      full: false,
    });
    expect(workspaceUsage({ usedBytes: 0.9 * GIB, quotaBytes: GIB })).toMatchObject({ percent: 90, nearlyFull: true });
    expect(workspaceUsage({ usedBytes: 2 * GIB, quotaBytes: GIB })).toEqual({
      share: 200,
      percent: 100,
      nearlyFull: true,
      full: true,
    });
  });

  it("gives a workspace without a size no share, and calls it full only when its disk is down to the reserve", () => {
    const unlimited = { usedBytes: 40 * GIB, quotaBytes: 0, unlimited: true };
    expect(workspaceUsage(unlimited)).toEqual({ share: null, percent: null, nearlyFull: false, full: false });
    expect(workspaceUsage({ ...unlimited, freeDiskBytes: 5 * GIB })).toMatchObject({ full: false });
    expect(workspaceUsage({ ...unlimited, freeDiskBytes: WORKSPACE_DISK_RESERVE_BYTES })).toMatchObject({
      full: true,
      nearlyFull: true,
    });
  });
});

describe("attachment helpers", () => {
  it("keeps names as single safe path segments", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
    expect(safeFileName("a/b\\c:d?.txt")).toBe("a_b_c_d_.txt");
    expect(safeFileName("..")).toBe("attachment");
    expect(safeFileName(".env")).toBe("env");
  });

  it("lists attachments after the typed text", () => {
    const file = { name: "a.txt", path: "inbox/a.txt", size: 1 };
    expect(messageWithAttachments("Summarize this", [file])).toBe(
      "Summarize this\n\nAttached to the workspace:\n- `inbox/a.txt`",
    );
    expect(messageWithAttachments("", [file])).toBe("Attached to the workspace:\n- `inbox/a.txt`");
    expect(messageWithAttachments("Hi", [])).toBe("Hi");
  });

  it("splits a sent message back into the typed text and its attachments", () => {
    const files = [
      { name: "boleto.pdf", path: "inbox/boleto.pdf", size: 1 },
      { name: "nota (2).png", path: "inbox/nota (2).png", size: 2 },
    ];
    expect(splitMessageAttachments(messageWithAttachments("Anexe estes\n\nobrigado", files))).toEqual({
      text: "Anexe estes\n\nobrigado",
      attachments: [
        { name: "boleto.pdf", path: "inbox/boleto.pdf" },
        { name: "nota (2).png", path: "inbox/nota (2).png" },
      ],
    });
    expect(splitMessageAttachments(messageWithAttachments("", files.slice(0, 1)))).toEqual({
      text: "",
      attachments: [{ name: "boleto.pdf", path: "inbox/boleto.pdf" }],
    });
  });

  it("previews a message by its typed text, or its files when nothing was typed", () => {
    const file = { name: "boleto.pdf", path: "inbox/boleto.pdf", size: 1 };
    const other = { name: "luz.pdf", path: "inbox/luz.pdf", size: 1 };
    expect(messagePreview(messageWithAttachments("Anexe", [file]))).toBe("Anexe");
    expect(messagePreview(messageWithAttachments("", [file, other]))).toBe("boleto.pdf, luz.pdf");
    expect(messagePreview("Hi")).toBe("Hi");
  });

  it("leaves messages that only mention the attachment heading whole", () => {
    for (const message of [
      "Hi",
      "Attached to the workspace:",
      "Attached to the workspace:\n- `inbox/a.txt`\nand more",
      "Quoted: Attached to the workspace:\n- `inbox/a.txt`",
    ]) {
      expect(splitMessageAttachments(message)).toEqual({ text: message, attachments: [] });
    }
  });
});
