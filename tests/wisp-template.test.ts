import { describe, expect, it } from "vitest";

import { WISP_SOUL_MAX_LENGTH } from "../shared/conversations.js";
import { MAX_SKILLS_PER_WISP } from "../shared/skills.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";
import {
  MAX_WISP_TEMPLATE_TEXT_LENGTH,
  parseWispTemplate,
  serializeWispTemplate,
  wispTemplateFrom,
  type WispTemplate,
} from "../shared/wisp-template.js";

const wisp = { name: "Atlas", role: "Research", soul: "# Who you are\nA careful researcher." };
const skill = (name: string, body = "1. Search.\n2. Cite.") =>
  `---\nname: ${name}\ndescription: Finds and cites sources.\n---\n${body}\n`;
const GIB = 1024 * 1024 * 1024;

const complete: WispTemplate = {
  ...wisp,
  description: "Finds, compares and summarizes sources, with citations.",
  appearance: { ...DEFAULT_WISP_APPEARANCE, body: "drop", eyes: "dot" },
  color: "#54b9a6",
  model: { providerId: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "high" },
  skills: [{ contents: skill("cite-sources") }, { contents: skill("weekly-digest") }],
  setup: { quotaBytes: 2 * GIB, executionMode: "container" },
  access: {
    files: { create_file: "allow", modify_file: "ask" },
    allowEverything: false,
    plugins: [{ pluginId: "linear", access: "write" }],
    mcpServers: [{ serverId: "github", name: "GitHub", access: "use_with_approval" }],
  },
};

const v2 = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: "wisp-template", version: 2, ...wisp, ...fields });

describe("Wisp templates", () => {
  it("round-trips a Wisp with its model", () => {
    const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", maxOutputTokens: 4096 };
    expect(parseWispTemplate(serializeWispTemplate(wispTemplateFrom(wisp, model)))).toEqual({
      ok: true,
      template: { ...wisp, model },
    });
  });

  it("carries the model's thinking level, dropping one this app does not know", () => {
    const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "high" as const };
    expect(parseWispTemplate(serializeWispTemplate(wispTemplateFrom(wisp, model)))).toEqual({
      ok: true,
      template: { ...wisp, model },
    });
    const unknown = JSON.stringify({
      format: "wisp-template",
      version: 1,
      ...wisp,
      model: { providerId: "a", modelId: "b", thinkingLevel: "extreme" },
    });
    expect(parseWispTemplate(unknown)).toEqual({
      ok: true,
      template: { ...wisp, model: { providerId: "a", modelId: "b" } },
    });
  });

  it("round-trips a Wisp without a model", () => {
    expect(parseWispTemplate(`\n${serializeWispTemplate(wispTemplateFrom(wisp, null))}\n`)).toEqual({
      ok: true,
      template: wisp,
    });
  });

  it("writes a template that uses nothing new as version 1, so older apps still read it", () => {
    expect(JSON.parse(serializeWispTemplate(wispTemplateFrom(wisp, null)))).toMatchObject({ version: 1 });
    expect(JSON.parse(serializeWispTemplate({ ...wisp, skills: [] }))).toMatchObject({ version: 2 });
  });

  it("round-trips a complete template: soul, skills, model, setup and requested access", () => {
    const text = serializeWispTemplate(complete);
    expect(JSON.parse(text)).toMatchObject({ format: "wisp-template", version: 2 });
    expect(parseWispTemplate(text)).toEqual({ ok: true, template: complete });
  });

  it("reads a version 1 template as one, ignoring fields version 1 never wrote", () => {
    const text = JSON.stringify({
      format: "wisp-template",
      version: 1,
      ...wisp,
      skills: [{ contents: skill("cite-sources") }],
      access: { allowEverything: true },
    });
    expect(parseWispTemplate(text)).toEqual({ ok: true, template: wisp });
  });

  it("keeps a template whose look this app cannot draw, with the default look and no color", () => {
    expect(parseWispTemplate(v2({ appearance: { body: "cube", eyes: "dot" }, color: "#123456" }))).toEqual({
      ok: true,
      template: { ...wisp, appearance: { ...DEFAULT_WISP_APPEARANCE, eyes: "dot" } },
    });
  });

  it("leaves out a plugin this app does not have", () => {
    expect(
      parseWispTemplate(
        v2({
          access: {
            plugins: [
              { pluginId: "linear", access: "read" },
              { pluginId: "fax", access: "write" },
            ],
          },
        }),
      ),
    ).toEqual({ ok: true, template: { ...wisp, access: { plugins: [{ pluginId: "linear", access: "read" }] } } });
  });

  it("accepts a workspace without a size", () => {
    expect(parseWispTemplate(v2({ setup: { quotaBytes: null } }))).toEqual({
      ok: true,
      template: { ...wisp, setup: { quotaBytes: null } },
    });
  });

  it("says which skill is broken and refuses two skills with one name", () => {
    expect(
      parseWispTemplate(v2({ skills: [{ contents: skill("ok-one") }, { contents: "# no frontmatter" }] })),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("Skill 2 in this template is not valid"),
    });
    expect(parseWispTemplate(v2({ skills: [{ contents: skill("twin") }, { contents: skill("twin") }] }))).toEqual({
      ok: false,
      error: "This template has two skills named twin.",
    });
    const tooMany = Array.from({ length: MAX_SKILLS_PER_WISP + 1 }, (_, index) => ({ contents: skill(`s-${index}`) }));
    expect(parseWispTemplate(v2({ skills: tooMany }))).toMatchObject({ ok: false });
  });

  it("asks for an update when a newer app made the template", () => {
    const text = JSON.stringify({ format: "wisp-template", version: 3, ...wisp });
    expect(parseWispTemplate(text)).toEqual({ ok: false, error: expect.stringContaining("newer version") });
  });

  it.each([
    ["plain text", "Atlas"],
    ["another format", JSON.stringify({ format: "other", version: 1, ...wisp })],
    ["version 0", JSON.stringify({ format: "wisp-template", version: 0, ...wisp })],
    ["an empty name", JSON.stringify({ format: "wisp-template", version: 1, ...wisp, name: " " })],
    ["a missing soul", JSON.stringify({ format: "wisp-template", version: 1, name: "Atlas", role: "" })],
    [
      "an oversized soul",
      JSON.stringify({ format: "wisp-template", version: 1, ...wisp, soul: "x".repeat(WISP_SOUL_MAX_LENGTH + 1) }),
    ],
    [
      "a model without an ID",
      JSON.stringify({ format: "wisp-template", version: 1, ...wisp, model: { providerId: "a" } }),
    ],
    [
      "an invalid output limit",
      JSON.stringify({
        format: "wisp-template",
        version: 1,
        ...wisp,
        model: { providerId: "a", modelId: "b", maxOutputTokens: 0 },
      }),
    ],
    ["a size that is not offered", v2({ setup: { quotaBytes: 3 * GIB } })],
    ["an unknown way to run commands", v2({ setup: { executionMode: "host" } })],
    ["an unknown file category", v2({ access: { files: { delete_file: "allow" } } })],
    ["an unknown file behavior", v2({ access: { files: { create_file: "always" } } })],
    ["risk mode that is not a switch", v2({ access: { allowEverything: "yes" } })],
    ["a plugin with no access level", v2({ access: { plugins: [{ pluginId: "linear", access: "none" }] } })],
    [
      "an MCP server id that cannot exist",
      v2({ access: { mcpServers: [{ serverId: "../x", name: "X", access: "allow_all" }] } }),
    ],
    [
      "an MCP server without a name",
      v2({ access: { mcpServers: [{ serverId: "github", name: " ", access: "allow_all" }] } }),
    ],
    ["an oversized description", v2({ description: "x".repeat(201) })],
    ["an oversized text", ` ${"x".repeat(MAX_WISP_TEMPLATE_TEXT_LENGTH + 1)}`],
  ])("rejects %s", (_case, text) => {
    expect(parseWispTemplate(text)).toEqual({ ok: false, error: expect.stringContaining("not a valid Wisp template") });
  });
});
