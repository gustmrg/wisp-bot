import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import { parseWispTemplate, serializeWispTemplate, type WispTemplate } from "../../shared/wisp-template";
import { applyTemplateChoices, captureWispTemplate, initialTemplateChoices } from "@/lib/wisp-template-actions";

const ok = <T>(value: T) => ({ ok: true as const, value });
const MIB = 1024 * 1024;
const wisp = {
  id: "w1",
  name: "Atlas",
  role: "Research",
  soul: "# Atlas",
  appearance: { ...DEFAULT_WISP_APPEARANCE, body: "drop" as const },
  color: "#54b9a6",
};

function install(overrides: Record<string, unknown> = {}) {
  const api = {
    getConversationModel: vi.fn(async () =>
      ok({ override: { providerId: "anthropic", modelId: "claude-sonnet-5-5" }, effective: null }),
    ),
    listSkills: vi.fn(async () =>
      ok([{ name: "cite-sources", description: "Cites every claim.", instructions: "1. Cite.", updatedAt: "x" }]),
    ),
    getWorkspace: vi.fn(async () => ok({ usedBytes: 0, quotaBytes: 128 * MIB, maxQuotaBytes: 128 * MIB })),
    getWispExecution: vi.fn(async () => ok({ mode: "container" })),
    getWispToolPolicy: vi.fn(async () => ok({ files: { create_file: "allow" }, allowEverything: false })),
    saveWispToolPolicy: vi.fn(async () => ok({})),
    getWispPluginAccess: vi.fn(async () =>
      ok({
        revision: "p1",
        grants: [
          { pluginId: "linear", access: "write" },
          { pluginId: "gmail", access: "none" },
        ],
      }),
    ),
    saveWispPluginAccess: vi.fn(async () => ok({})),
    getWispMcpAccess: vi.fn(async () => ok({ revision: "m1", grants: [{ serverId: "github", access: "allow_all" }] })),
    saveWispMcpAccess: vi.fn(async () => ok({})),
    getMcpSettings: vi.fn(async () => ok({ servers: [{ serverId: "github", name: "GitHub" }] })),
    importSkill: vi.fn(async () => ok([])),
    ...overrides,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

afterEach(() => {
  Reflect.deleteProperty(window, "wisp");
});

describe("captureWispTemplate", () => {
  it("captures the Wisp's look, soul, own model, skills, setup and access, as a valid template", async () => {
    install();
    const template = await captureWispTemplate("c1", wisp);
    expect(template).toEqual({
      name: "Atlas",
      role: "Research",
      soul: "# Atlas",
      appearance: wisp.appearance,
      color: "#54b9a6",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
      skills: [{ contents: '---\nname: cite-sources\ndescription: "Cites every claim."\n---\n\n1. Cite.\n' }],
      setup: { quotaBytes: 128 * MIB, executionMode: "container" },
      access: {
        files: { create_file: "allow" },
        plugins: [{ pluginId: "linear", access: "write" }],
        mcpServers: [{ serverId: "github", name: "GitHub", access: "allow_all" }],
      },
    });
    expect(parseWispTemplate(serializeWispTemplate(template))).toEqual({ ok: true, template });
  });

  it("leaves out what the server does not answer, a model the Wisp did not choose, and a size not offered", async () => {
    const unsupported = vi.fn(async () => ({ ok: false, error: { code: "unsupported", message: "x" } }));
    install({
      getConversationModel: vi.fn(async () => ok({ override: null, effective: { providerId: "a", modelId: "b" } })),
      getWorkspace: vi.fn(async () => ok({ usedBytes: 0, quotaBytes: 3 * MIB, maxQuotaBytes: 0 })),
      getWispExecution: unsupported,
      getWispToolPolicy: unsupported,
      getWispPluginAccess: unsupported,
      getWispMcpAccess: vi.fn(async () => {
        throw new Error("offline");
      }),
      listSkills: vi.fn(async () => ok([])),
    });
    expect(await captureWispTemplate("c1", { ...wisp, color: undefined })).toEqual({
      name: "Atlas",
      role: "Research",
      soul: "# Atlas",
      appearance: wisp.appearance,
    });
  });
});

describe("applyTemplateChoices", () => {
  const template: WispTemplate = {
    name: "Atlas",
    role: "",
    soul: "",
    skills: [
      { contents: "---\nname: one\ndescription: First.\n---\n1. A.\n" },
      { contents: "---\nname: two\ndescription: Second.\n---\n1. B.\n" },
    ],
    access: {
      files: { modify_file: "allow" },
      allowEverything: true,
      plugins: [{ pluginId: "gmail", access: "read" }],
      mcpServers: [{ serverId: "notion", name: "Notion", access: "use_with_approval" }],
    },
  };

  it("gives every skill but no access when nothing was changed", async () => {
    const api = install();
    expect(await applyTemplateChoices("c1", template, initialTemplateChoices(template))).toEqual([]);
    const calls = api.importSkill.mock.calls as unknown as Array<[{ contents: string }]>;
    expect(calls.map(([request]) => request.contents)).toEqual(template.skills!.map(({ contents }) => contents));
    expect(api.saveWispToolPolicy).not.toHaveBeenCalled();
    expect(api.saveWispPluginAccess).not.toHaveBeenCalled();
    expect(api.saveWispMcpAccess).not.toHaveBeenCalled();
  });

  it("applies only the chosen skills and access, keeping what the Wisp already had", async () => {
    const api = install();
    await applyTemplateChoices("c1", template, {
      skills: new Set([1]),
      files: true,
      allowEverything: true,
      plugins: new Set(["gmail"]),
      mcpServers: new Set(["notion"]),
    });
    expect(api.importSkill).toHaveBeenCalledExactlyOnceWith({
      conversationId: "c1",
      contents: template.skills![1]!.contents,
    });
    expect(api.saveWispToolPolicy).toHaveBeenCalledWith({
      conversationId: "c1",
      files: { create_file: "allow", modify_file: "allow" },
      allowEverything: true,
    });
    expect(api.saveWispPluginAccess).toHaveBeenCalledWith({
      conversationId: "c1",
      revision: "p1",
      grants: [
        { pluginId: "linear", access: "write" },
        { pluginId: "gmail", access: "read" },
      ],
    });
    expect(api.saveWispMcpAccess).toHaveBeenCalledWith({
      conversationId: "c1",
      revision: "m1",
      grants: [
        { serverId: "github", access: "allow_all" },
        { serverId: "notion", access: "use_with_approval" },
      ],
    });
  });

  it("reports each part that could not be applied and carries on with the rest", async () => {
    const api = install({
      importSkill: vi.fn(async () => ({ ok: false, error: { code: "invalid_request", message: "Too many skills." } })),
      saveWispPluginAccess: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const failures = await applyTemplateChoices("c1", template, {
      ...initialTemplateChoices(template),
      skills: new Set([0]),
      plugins: new Set(["gmail"]),
      mcpServers: new Set(["notion"]),
    });
    expect(failures).toEqual(["the one skill (Too many skills.)", "its plugin access (no answer)"]);
    expect(api.saveWispMcpAccess).toHaveBeenCalled();
  });
});
