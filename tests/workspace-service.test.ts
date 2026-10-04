import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { measureDirectory, safeFileName, WorkspaceService } from "../electron/backend/workspace-service.js";
import { messageWithAttachments } from "../shared/workspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(selected: string[] = [], quotaBytes?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-workspace-"));
  directories.push(root);
  const workspaceDirectory = path.join(root, "workspaces", "session");
  const configDirectory = path.join(root, "pi-config", "session");
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
});
