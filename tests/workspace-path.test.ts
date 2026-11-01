import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fromContainerPath, resolveWorkspacePath } from "../backend/workspace-path.js";

describe("resolveWorkspacePath", () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisp-workspace-path-")));
    workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "repo"), { recursive: true });
    await writeFile(path.join(workspace, "repo", "notes.md"), "notes");
    await writeFile(path.join(root, "outside.md"), "outside");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves relative paths and real paths inside the workspace", async () => {
    await expect(resolveWorkspacePath(workspace, "repo/notes.md", false)).resolves.toMatchObject({
      canonicalPath: path.join(workspace, "repo", "notes.md"),
      relativePath: path.join("repo", "notes.md"),
    });
    await expect(resolveWorkspacePath(workspace, path.join(workspace, "repo"), false)).resolves.toMatchObject({
      relativePath: "repo",
    });
  });

  it.each([
    ["/workspace", "."],
    ["/workspace/", "."],
    ["/workspace/repo", "repo"],
    ["/workspace/repo/notes.md", path.join("repo", "notes.md")],
    ["/workspace/repo/../repo/notes.md", path.join("repo", "notes.md")],
    ["//workspace/repo", "repo"],
  ])("reads the container path %s as the same file", async (requested, relativePath) => {
    await expect(resolveWorkspacePath(workspace, requested, false)).resolves.toMatchObject({
      canonicalPath: path.join(workspace, relativePath),
      relativePath,
    });
  });

  it("creates new files from a container path inside the workspace", async () => {
    await expect(resolveWorkspacePath(workspace, "/workspace/repo/new.md", true)).resolves.toEqual({
      canonicalPath: path.join(workspace, "repo", "new.md"),
      relativePath: path.join("repo", "new.md"),
      exists: false,
    });
  });

  it.each(["/workspace/../etc/passwd", "/workspacefoo", "/workspacefoo/repo", "/workspace/repo/../../etc", "/etc"])(
    "refuses %s",
    async (requested) => {
      await expect(resolveWorkspacePath(workspace, requested, false)).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("outside this Wisp's workspace"),
      });
    },
  );

  it("refuses a symbolic link out of the workspace through a container path", async () => {
    await symlink(path.join(root, "outside.md"), path.join(workspace, "link.md"));
    await expect(resolveWorkspacePath(workspace, "/workspace/link.md", false)).rejects.toMatchObject({
      message: expect.stringContaining("outside this Wisp's workspace"),
    });
    await expect(resolveWorkspacePath(workspace, "link.md", false)).rejects.toMatchObject({
      message: expect.stringContaining("outside this Wisp's workspace"),
    });
  });
});

describe("fromContainerPath", () => {
  it("keeps a real path first when the workspace itself sits under /workspace", () => {
    expect(fromContainerPath("/workspace/data/wisp", "/workspace/data/wisp/repo")).toBe("/workspace/data/wisp/repo");
    expect(fromContainerPath("/workspace/data/wisp", "/workspace/repo")).toBe("repo");
  });

  it("leaves relative paths and other absolute paths alone", () => {
    expect(fromContainerPath("/data/wisp", "workspace/repo")).toBe("workspace/repo");
    expect(fromContainerPath("/data/wisp", "/data/wisp/repo")).toBe("/data/wisp/repo");
  });
});
