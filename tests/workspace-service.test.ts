import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { measureDirectory, safeFileName, WorkspaceService } from "../backend/workspace-service.js";
import { messageWithAttachments, splitMessageAttachments } from "../shared/workspace.js";

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
        return circleWorkspace;
      },
      openPath,
      selectFiles: async () => [],
    });

    await service.openWorkspace("crew");

    expect(openPath).toHaveBeenCalledWith(circleWorkspace);
    expect((await stat(circleWorkspace)).isDirectory()).toBe(true);
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
