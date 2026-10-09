import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSkillDocument, parseSkillFile, SkillStore } from "../backend/skill-store.js";
import { MAX_SKILLS_PER_WISP } from "../shared/skills.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-skills-"));
  directories.push(root);
  const directory = path.join(root, "skills");
  return { root, directory, store: new SkillStore(directory) };
}

describe("SkillStore", () => {
  it("saves Agent Skills folders and reads them back", async () => {
    const { directory, store } = await createStore();
    expect(await store.list()).toEqual([]);

    const saved = await store.save({
      name: "weekly-report",
      description: "Builds the weekly report.\nUse on Fridays.",
      instructions: "  1. Collect issues.\n2. Summarize.  ",
    });

    expect(saved).toMatchObject({
      name: "weekly-report",
      description: "Builds the weekly report. Use on Fridays.",
      instructions: "1. Collect issues.\n2. Summarize.",
    });
    expect(await readFile(path.join(directory, "weekly-report", "SKILL.md"), "utf8")).toBe(
      '---\nname: weekly-report\ndescription: "Builds the weekly report. Use on Fridays."\n---\n\n1. Collect issues.\n2. Summarize.\n',
    );
    expect(await store.summaries()).toEqual([
      { name: "weekly-report", description: saved.description, updatedAt: saved.updatedAt },
    ]);
    await store.delete("weekly-report");
    expect(await store.get("weekly-report")).toBeNull();
    await expect(store.delete("weekly-report")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads hand-written skills and skips malformed, symlinked, or misnamed ones", async () => {
    const { root, directory, store } = await createStore();
    await mkdir(path.join(directory, "plain"), { recursive: true });
    await writeFile(
      path.join(directory, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: Plain value: with colon\nlicense: MIT\n---\nDo the thing.\n",
    );
    await mkdir(path.join(directory, "no-description"));
    await writeFile(path.join(directory, "no-description", "SKILL.md"), "---\nname: x\n---\nBody");
    await mkdir(path.join(directory, "Bad_Name"));
    await writeFile(path.join(directory, "Bad_Name", "SKILL.md"), "---\ndescription: d\n---\nBody");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "---\ndescription: outside\n---\nBody");
    await symlink(outside, path.join(directory, "linked"));
    await mkdir(path.join(directory, "file-link"));
    await symlink(path.join(outside, "SKILL.md"), path.join(directory, "file-link", "SKILL.md"));

    expect(await store.list()).toEqual([
      expect.objectContaining({ name: "plain", description: "Plain value: with colon", instructions: "Do the thing." }),
    ]);
    expect(await store.get("../outside")).toBeNull();
  });

  it("rejects invalid drafts and caps the number of skills", async () => {
    const { store } = await createStore();
    await expect(store.save({ name: "Bad Name", description: "d", instructions: "i" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.save({ name: "ok", description: " ", instructions: "i" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(store.save({ name: "ok", description: "d", instructions: "x".repeat(16_001) })).rejects.toMatchObject({
      code: "invalid_request",
    });

    for (let index = 0; index < MAX_SKILLS_PER_WISP; index += 1) {
      await store.save({ name: `skill-${index}`, description: "d", instructions: "i" });
    }
    await expect(store.save({ name: "one-more", description: "d", instructions: "i" })).rejects.toMatchObject({
      message: expect.stringContaining("Delete one"),
    });
    await expect(store.save({ name: "skill-0", description: "updated", instructions: "i" })).resolves.toMatchObject({
      description: "updated",
    });
  });
});

describe("parseSkillFile", () => {
  it("accepts quoted values and rejects files without frontmatter", () => {
    expect(parseSkillFile('---\nname: "quoted"\ndescription: "A \\"quoted\\" value"\n---\nBody')).toEqual({
      name: "quoted",
      description: 'A "quoted" value',
      instructions: "Body",
    });
    expect(parseSkillFile("---\ndescription: 'single'\n---\n")).toEqual({
      name: "",
      description: "single",
      instructions: "",
    });
    expect(parseSkillFile("---\ndescription: >\n  folded\n---\nBody")).toMatchObject({ description: "" });
    expect(parseSkillFile("No frontmatter")).toBeNull();
  });
});

describe("importing a SKILL.md", () => {
  const file = "\ufeff---\nname: gh-flow\ndescription: Opens pull requests.\nlicense: MIT\n---\n\n1. Branch.\n2. Push.";

  it("saves the file as written, keeping fields Wisp does not use", async () => {
    const { directory, store } = await createStore();

    await expect(store.import(file)).resolves.toMatchObject({
      name: "gh-flow",
      description: "Opens pull requests.",
      instructions: "1. Branch.\n2. Push.",
    });
    expect(await readFile(path.join(directory, "gh-flow", "SKILL.md"), "utf8")).toBe(`${file.slice(1)}\n`);
  });

  it("explains what is wrong with files that are not skills", () => {
    const message = (contents: unknown) => {
      try {
        parseSkillDocument(contents);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(message("  ")).toContain("empty");
    expect(message("# Just markdown")).toContain("frontmatter");
    expect(message("---\ndescription: d\n---\nBody")).toContain("name field");
    expect(message("---\nname: Bad Name\ndescription: d\n---\nBody")).toContain("Skill names");
    expect(message("---\nname: ok\ndescription: >\n  folded\n---\nBody")).toContain("description");
    expect(message("---\nname: ok\ndescription: d\n---\n")).toContain("instructions");
    expect(message(`---\nname: ok\ndescription: d\n---\n${"x".repeat(64 * 1024)}`)).toContain("64 KiB");
  });
});
