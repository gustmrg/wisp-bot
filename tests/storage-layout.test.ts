import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { migrateStorageFolders, renamedSessionFile } from "../backend/storage-layout.js";

async function dataDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "wisp-storage-layout-"));
}

async function put(directory: string, relative: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await writeFile(path.join(directory, relative), contents);
}

describe("migrateStorageFolders", () => {
  it("does nothing for a data directory that has neither old folder", async () => {
    const directory = await dataDirectory();
    await put(directory, "wisp-config/one/memory.md", "kept");

    await migrateStorageFolders(directory);

    expect((await readdir(directory)).sort()).toEqual(["wisp-config"]);
    expect(await readFile(path.join(directory, "wisp-config/one/memory.md"), "utf8")).toBe("kept");
  });

  it("moves both folders under their new names, with everything inside them", async () => {
    const directory = await dataDirectory();
    await put(directory, "pi-config/one/skills/search/SKILL.md", "skill");
    await put(directory, "pi-config/one/context-settings.json", "{}");
    await put(directory, "pi-sessions/session-1/history.jsonl", "history");
    await put(directory, "pi-sessions/session-1/claude-code-session.json", "{}");
    await put(directory, "workspaces/one/notes.md", "notes");

    await migrateStorageFolders(directory);

    expect((await readdir(directory)).sort()).toEqual(["wisp-config", "wisp-sessions", "workspaces"]);
    expect(await readFile(path.join(directory, "wisp-config/one/skills/search/SKILL.md"), "utf8")).toBe("skill");
    expect(await readFile(path.join(directory, "wisp-sessions/session-1/history.jsonl"), "utf8")).toBe("history");
    expect(await readFile(path.join(directory, "wisp-sessions/session-1/claude-code-session.json"), "utf8")).toBe("{}");
    expect(await readFile(path.join(directory, "workspaces/one/notes.md"), "utf8")).toBe("notes");
  });

  it("finishes a run that stopped after the first move, and is a no-op when repeated", async () => {
    const directory = await dataDirectory();
    await put(directory, "wisp-config/one/memory.md", "moved");
    await put(directory, "pi-sessions/session-1/history.jsonl", "waiting");

    await migrateStorageFolders(directory);
    await migrateStorageFolders(directory);

    expect((await readdir(directory)).sort()).toEqual(["wisp-config", "wisp-sessions"]);
    expect(await readFile(path.join(directory, "wisp-sessions/session-1/history.jsonl"), "utf8")).toBe("waiting");
  });

  it("drops an empty old folder that sits beside the new one", async () => {
    const directory = await dataDirectory();
    await mkdir(path.join(directory, "pi-config"));
    await put(directory, "wisp-config/one/memory.md", "kept");

    await migrateStorageFolders(directory);

    expect((await readdir(directory)).sort()).toEqual(["wisp-config"]);
    expect(await readFile(path.join(directory, "wisp-config/one/memory.md"), "utf8")).toBe("kept");
  });

  it("stops, touching nothing, when both folders hold data", async () => {
    const directory = await dataDirectory();
    await put(directory, "pi-sessions/session-1/history.jsonl", "old");
    await put(directory, "wisp-sessions/session-2/history.jsonl", "new");

    await expect(migrateStorageFolders(directory)).rejects.toThrow("Both pi-sessions and wisp-sessions hold data");

    expect(await readFile(path.join(directory, "pi-sessions/session-1/history.jsonl"), "utf8")).toBe("old");
    expect(await readFile(path.join(directory, "wisp-sessions/session-2/history.jsonl"), "utf8")).toBe("new");
  });
});

describe("renamedSessionFile", () => {
  it("renames the session folder of a job run's file, with either separator", () => {
    expect(renamedSessionFile("/data/pi-sessions/s1/jobs/job-1/run-1.jsonl")).toBe(
      "/data/wisp-sessions/s1/jobs/job-1/run-1.jsonl",
    );
    expect(renamedSessionFile("C:\\data\\pi-sessions\\s1\\jobs\\job-1\\run-1.jsonl")).toBe(
      "C:\\data\\wisp-sessions\\s1\\jobs\\job-1\\run-1.jsonl",
    );
  });

  it("leaves other paths alone, including a data directory that happens to be named pi-sessions", () => {
    expect(renamedSessionFile("/data/wisp-sessions/s1/jobs/job-1/run-1.jsonl")).toBe(
      "/data/wisp-sessions/s1/jobs/job-1/run-1.jsonl",
    );
    expect(renamedSessionFile("/pi-sessions/backend/wisp-sessions/s1/jobs/job-1/run-1.jsonl")).toBe(
      "/pi-sessions/backend/wisp-sessions/s1/jobs/job-1/run-1.jsonl",
    );
  });
});
