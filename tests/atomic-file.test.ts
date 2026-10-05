import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        calls.push(`sync:${path.basename(String(args[0]))}`);
        return sync();
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      calls.push("rename");
      return actual.rename(...args);
    },
  };
});

import { writeFileAtomically } from "../backend/atomic-file.js";

describe("writeFileAtomically", () => {
  it("flushes the data before the rename and the directory after it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-atomic-"));
    const target = path.join(directory, "settings.json");
    calls.length = 0;

    await writeFileAtomically(target, '{"ok":true}\n');

    await expect(readFile(target, "utf8")).resolves.toBe('{"ok":true}\n');
    expect(await readdir(directory)).toEqual(["settings.json"]);
    const renameIndex = calls.indexOf("rename");
    expect(calls.slice(0, renameIndex)).toEqual([expect.stringMatching(/^sync:settings\.json\..*\.tmp$/)]);
    if (process.platform !== "win32") {
      expect(calls.slice(renameIndex + 1)).toEqual([`sync:${path.basename(directory)}`]);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes the temporary file when the write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-atomic-fail-"));
    // A directory at the target path makes the rename fail after the data is written.
    const target = path.join(directory, "occupied");
    await mkdir(path.join(target, "child"), { recursive: true });

    await expect(writeFileAtomically(target, "data")).rejects.toBeDefined();

    expect(await readdir(directory)).toEqual(["occupied"]);
  });
});
