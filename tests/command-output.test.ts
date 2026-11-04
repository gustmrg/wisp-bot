import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  KEPT_OUTPUTS,
  keepFullOutput,
  MAX_KEPT_OUTPUT_BYTES,
  pointToKeptOutput,
  withKeptOutput,
} from "../backend/command-output.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-command-output-"));
  created.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, kept: path.join(workspace, ".home", "command-output") };
}

/** A file named as Pi's shell tool names the full output of a long command. */
async function piOutput(contents: string): Promise<string> {
  const file = path.join(os.tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
  await writeFile(file, contents);
  created.push(file);
  return file;
}

describe("keepFullOutput", () => {
  it("moves Pi's temporary file into the home folder and deletes it from the server's", async () => {
    const { workspace, kept } = await setup();
    const file = await piOutput("line\n".repeat(10));

    const moved = await keepFullOutput(file, workspace, "/workspace/.home", new Date("2026-11-02T15:30:12.345Z"));

    expect(moved.kept).toEqual({
      path: expect.stringMatching(/^\/workspace\/\.home\/command-output\/20261102T153012Z-[0-9a-f]{8}\.log$/),
      bytes: 50,
      keptBytes: 50,
    });
    await expect(readFile(path.join(kept, path.posix.basename(moved.kept!.path)), "utf8")).resolves.toBe(
      "line\n".repeat(10),
    );
    await expect(access(file)).rejects.toThrow();
    expect(pointToKeptOutput(`[Showing lines 3-10 of 10. Full output: ${file}]`, moved)).toBe(
      `[Showing lines 3-10 of 10. Full output: ${moved.kept!.path}]`,
    );
  });

  it("keeps the beginning and the end of an output past the limit", async () => {
    const { workspace, kept } = await setup();
    const head = "a".repeat(MAX_KEPT_OUTPUT_BYTES / 2);
    const tail = "c".repeat(MAX_KEPT_OUTPUT_BYTES / 2);
    const file = await piOutput(`${head}${"b".repeat(1000)}${tail}`);

    const moved = await keepFullOutput(file, workspace, "/workspace/.home");

    expect(moved.kept).toMatchObject({ bytes: MAX_KEPT_OUTPUT_BYTES + 1000, keptBytes: MAX_KEPT_OUTPUT_BYTES });
    const contents = await readFile(path.join(kept, path.posix.basename(moved.kept!.path)), "utf8");
    expect(contents).toBe(`${head}\n\n[1000 B left out]\n\n${tail}`);
    expect(pointToKeptOutput(`Full output: ${file}]`, moved)).toBe(
      `Full output, its first and last 512 KiB of 1.0 MiB: ${moved.kept!.path}]`,
    );
  });

  it("keeps only the newest outputs of a home folder", async () => {
    const { workspace, kept } = await setup();
    for (let run = 0; run < KEPT_OUTPUTS + 2; run += 1) {
      await keepFullOutput(
        await piOutput(`run ${run}`),
        workspace,
        "/workspace/.home",
        new Date(Date.UTC(2026, 10, 2, 15, 30, run)),
      );
    }

    const names = (await readdir(kept)).sort();
    expect(names).toHaveLength(KEPT_OUTPUTS);
    await expect(readFile(path.join(kept, names[0]!), "utf8")).resolves.toBe("run 2");
  });

  it("keeps a circle member's output in its own home folder", async () => {
    const { workspace } = await setup();

    const moved = await keepFullOutput(await piOutput("output"), workspace, "/workspace/.home/s1");

    expect(moved.kept?.path).toMatch(/^\/workspace\/\.home\/s1\/command-output\//);
    await expect(readdir(path.join(workspace, ".home", "s1", "command-output"))).resolves.toHaveLength(1);
  });

  it("does not follow a home folder that links out of the workspace", async () => {
    const { root, workspace } = await setup();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(workspace, ".home"));
    const file = await piOutput("output");

    const moved = await keepFullOutput(file, workspace, "/workspace/.home");

    expect(moved.kept).toBeNull();
    await expect(readdir(outside)).resolves.toEqual([]);
    await expect(access(file)).rejects.toThrow();
    expect(pointToKeptOutput(`[Showing lines 1-2 of 9. Full output: ${file}]`, moved)).toBe(
      "[Showing lines 1-2 of 9. The full output could not be kept]",
    );
  });

  it("neither reads nor deletes a file Pi did not write", async () => {
    const { root, workspace, kept } = await setup();
    const elsewhere = path.join(root, "pi-bash-0123abcd.log");
    const misnamed = path.join(os.tmpdir(), `wisp-test-${randomBytes(8).toString("hex")}.log`);
    created.push(misnamed);
    await writeFile(elsewhere, "private");
    await writeFile(misnamed, "private");

    for (const file of [elsewhere, misnamed]) {
      expect((await keepFullOutput(file, workspace, "/workspace/.home")).kept).toBeNull();
      await expect(readFile(file, "utf8")).resolves.toBe("private");
    }
    await expect(access(kept)).rejects.toThrow();
  });
});

describe("withKeptOutput", () => {
  it("names the kept output in the text, the details and the structured result", () => {
    const temporaryFile = path.join(os.tmpdir(), "pi-bash-0123abcd.log");
    const result = {
      content: [{ type: "text", text: `out\n\n[Showing lines 2-3 of 3. Full output: ${temporaryFile}]` }],
      details: { truncation: { truncated: true }, fullOutputPath: temporaryFile },
      structuredContent: { output: "out", truncated: true, full_output_path: temporaryFile, exit_code: 0 },
    };
    const kept = { path: "/workspace/.home/command-output/20261102T153012Z-0123abcd.log", bytes: 9, keptBytes: 9 };

    expect(withKeptOutput(result, { temporaryFile, kept })).toEqual({
      content: [{ type: "text", text: `out\n\n[Showing lines 2-3 of 3. Full output: ${kept.path}]` }],
      details: { truncation: { truncated: true }, fullOutputPath: kept.path },
      structuredContent: { output: "out", truncated: true, full_output_path: kept.path, exit_code: 0 },
    });
    expect(withKeptOutput(result, { temporaryFile, kept: null })).toEqual({
      content: [{ type: "text", text: "out\n\n[Showing lines 2-3 of 3. The full output could not be kept]" }],
      details: { truncation: { truncated: true } },
      structuredContent: { output: "out", truncated: true, exit_code: 0 },
    });
  });
});
