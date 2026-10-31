import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseDeleteWispTemplateRequest, parseSaveWispTemplateRequest } from "../backend/validators.js";
import { WispTemplateStore } from "../backend/wisp-template-store.js";
import { BUILTIN_WISP_TEMPLATES } from "../shared/builtin-wisp-templates.js";
import { CHIEF_WISP } from "../shared/chief-wisp.js";
import { SOUL_TEMPLATES } from "../shared/soul-templates.js";
import { MAX_SAVED_WISP_TEMPLATES, parseWispTemplate, serializeWispTemplate } from "../shared/wisp-template.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-templates-"));
  directories.push(root);
  const directory = path.join(root, "wisp-templates");
  return { directory, store: new WispTemplateStore(directory) };
}

const skill = "---\nname: weekly-digest\ndescription: Sums up the week.\n---\n1. Read the notes.\n";
const atlas = serializeWispTemplate({
  name: "Atlas",
  role: "Research",
  soul: "# Atlas",
  skills: [{ contents: skill }],
  access: { plugins: [{ pluginId: "linear", access: "read" }] },
});

describe("built-in Wisp templates", () => {
  it("offer Chief and one complete template per starting soul, each valid and asking for no plugin or MCP access", () => {
    expect(BUILTIN_WISP_TEMPLATES.map(({ template }) => template.name)).toEqual([
      "Chief",
      "Quill",
      "Atlas",
      "Forge",
      "Pip",
      "Sage",
      "Owl",
    ]);
    expect(BUILTIN_WISP_TEMPLATES.map(({ id }) => id).sort()).toEqual(
      ["builtin-chief", ...SOUL_TEMPLATES.map(({ id }) => `builtin-${id}`)].sort(),
    );
    for (const { id, template } of BUILTIN_WISP_TEMPLATES) {
      expect(parseWispTemplate(serializeWispTemplate(template)), id).toEqual({ ok: true, template });
      expect(template.description, id).toBeTruthy();
      expect(template.access, id).toBeUndefined();
    }
    const code = BUILTIN_WISP_TEMPLATES.find(({ id }) => id === "builtin-code")!.template;
    expect(code.setup).toMatchObject({ executionMode: "container" });
    expect(code.skills).toHaveLength(1);
  });

  it("bring back the same Chief that onboarding creates", () => {
    const chief = BUILTIN_WISP_TEMPLATES.find(({ id }) => id === "builtin-chief")!.template;
    expect(chief).toMatchObject(CHIEF_WISP);
  });
});

describe("WispTemplateStore", () => {
  it("lists the built-ins first, then saved templates by name", async () => {
    const { store } = await setup();
    await store.save({ contents: serializeWispTemplate({ name: "Zed", role: "", soul: "" }) });
    await store.save({ contents: atlas });

    const list = await store.list();
    expect(list.slice(0, BUILTIN_WISP_TEMPLATES.length).every(({ builtIn, updatedAt }) => builtIn && !updatedAt)).toBe(
      true,
    );
    expect(list.slice(BUILTIN_WISP_TEMPLATES.length).map(({ template, builtIn }) => [template.name, builtIn])).toEqual([
      ["Atlas", false],
      ["Zed", false],
    ]);
  });

  it("round-trips a saved template with its skills and requested access, and replaces it by ID", async () => {
    const { store, directory } = await setup();
    const saved = await store.save({ contents: atlas });
    expect(saved).toMatchObject({ builtIn: false, template: parseWispTemplate(atlas).ok && { name: "Atlas" } });
    expect(saved.template.skills).toEqual([{ contents: skill }]);
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readdir(directory)).toEqual([`${saved.id}.json`]);

    const renamed = await store.save({
      id: saved.id,
      contents: serializeWispTemplate({ ...saved.template, name: "Atlas 2" }),
    });
    expect(renamed).toMatchObject({ id: saved.id, template: { name: "Atlas 2" } });
    expect((await store.list()).filter(({ builtIn }) => !builtIn)).toHaveLength(1);
  });

  it("stores only what it understood, never fields it does not know", async () => {
    const { store, directory } = await setup();
    const saved = await store.save({
      contents: JSON.stringify({
        ...JSON.parse(atlas),
        credentials: { apiKey: "sk-secret" },
        access: { plugins: [{ pluginId: "linear", access: "read", token: "lin_secret" }] },
      }),
    });
    const file = await readFile(path.join(directory, `${saved.id}.json`), "utf8");
    expect(file).not.toContain("secret");
  });

  it("refuses invalid templates, built-in IDs, unknown IDs, and more than the limit", async () => {
    const { store } = await setup();
    await expect(store.save({ contents: "{" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store.save({ id: "builtin-research", contents: atlas })).rejects.toMatchObject({
      message: expect.stringContaining("Built-in templates cannot be changed"),
    });
    await expect(store.delete("builtin-research")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store.save({ id: "../escape", contents: atlas })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store.delete("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });

    const { store: full, directory } = await setup();
    await full.save({ contents: atlas });
    const [first] = await readdir(directory);
    const contents = await readFile(path.join(directory, first!), "utf8");
    await Promise.all(
      Array.from({ length: MAX_SAVED_WISP_TEMPLATES - 1 }, (_, index) =>
        writeFile(path.join(directory, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}.json`), contents),
      ),
    );
    await expect(full.save({ contents: atlas })).rejects.toMatchObject({
      message: expect.stringContaining(`at most ${MAX_SAVED_WISP_TEMPLATES} templates`),
    });
  });

  it("deletes a saved template and leaves out files that no longer parse", async () => {
    const { store, directory } = await setup();
    const saved = await store.save({ contents: atlas });
    await writeFile(path.join(directory, "11111111-1111-4111-8111-111111111111.json"), "{ broken");
    await writeFile(path.join(directory, "notes.txt"), "not a template");
    expect((await store.list()).filter(({ builtIn }) => !builtIn).map(({ id }) => id)).toEqual([saved.id]);

    await store.delete(saved.id);
    expect((await store.list()).filter(({ builtIn }) => !builtIn)).toEqual([]);
  });

  it("checks requests before they reach the store", () => {
    expect(parseSaveWispTemplateRequest({ contents: atlas })).toEqual({ contents: atlas });
    expect(parseSaveWispTemplateRequest({ id: "x", contents: atlas })).toEqual({ id: "x", contents: atlas });
    for (const payload of [null, {}, { contents: 1 }, { contents: atlas, id: 3 }]) {
      expect(() => parseSaveWispTemplateRequest(payload)).toThrow();
    }
    expect(parseDeleteWispTemplateRequest({ id: "x" })).toEqual({ id: "x" });
    expect(() => parseDeleteWispTemplateRequest({ id: "" })).toThrow();
  });
});
