import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import { parseWispTemplate, serializeWispTemplate, type WispTemplate } from "../../shared/wisp-template";
import { captureWispTemplate, createWispFromTemplate } from "@/lib/wisp-template-actions";

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

describe("createWispFromTemplate", () => {
  const skill = "---\nname: brief\ndescription: Writes a brief.\n---\nBody";
  const template: WispTemplate = { name: "Atlas", role: " Research ", soul: " Soul ", skills: [{ contents: skill }] };

  function model(id: string) {
    return {
      id,
      name: id,
      reasoning: false,
      thinkingLevels: ["off"],
      input: ["text"],
      contextWindow: 1,
      maxOutputTokens: 1,
    };
  }

  function install({
    selection = { providerId: "openrouter", modelId: "alpha" } as { providerId: string; modelId: string } | null,
    runtime = { available: true, name: "docker", version: "1" } as unknown,
    maxQuotaBytes = 1024 ** 4,
    importOk = true,
  } = {}) {
    const api = {
      getAiSettings: vi.fn(async () => ({
        ok: true,
        value: {
          selection,
          secureStorageAvailable: true,
          providers: [
            { id: "openrouter", name: "OpenRouter", credentialConfigured: true, models: [model("alpha")] },
            { id: "google", name: "Google", credentialConfigured: false, models: [model("gemini")] },
          ],
          auxiliary: {},
          fallback: {},
          catalogError: null,
        },
      })),
      getWispSetup: vi.fn(async () => ({ ok: true, value: { maxQuotaBytes, runtime } })),
      setWorkspaceQuota: vi.fn(async () => ({ ok: true, value: {} })),
      saveWispExecution: vi.fn(async () => ({ ok: true, value: {} })),
      importSkill: vi.fn(async () =>
        importOk ? { ok: true, value: [] } : { ok: false, error: { message: "Bad skill." } },
      ),
      saveWispToolPolicy: vi.fn(),
      saveWispPluginAccess: vi.fn(),
      saveWispMcpAccess: vi.fn(),
    };
    Object.defineProperty(window, "wisp", { configurable: true, value: api });
    return { api, create: vi.fn(async () => "c1") };
  }

  it("creates the Wisp with its skills and nothing to review", async () => {
    const { api, create } = install();

    expect(await createWispFromTemplate(template, [], create)).toEqual({
      status: "created",
      name: "Atlas",
      notices: [],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Atlas", role: "Research", soul: "Soul" }),
      expect.objectContaining({ model: null }),
    );
    expect(api.importSkill).toHaveBeenCalledWith({ conversationId: "c1", contents: skill });
  });

  it("names a second Wisp from the same template apart from the first", async () => {
    const { create } = install();

    expect(await createWispFromTemplate(template, ["atlas", "Atlas 2"], create)).toMatchObject({ name: "Atlas 3" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas 3" }), expect.anything());
  });

  it("creates nothing and asks for a model while none can answer", async () => {
    const { create } = install({ selection: null });

    expect(await createWispFromTemplate(template, [], create)).toEqual({ status: "needs_model" });
    expect(create).not.toHaveBeenCalled();
  });

  it("uses the default model, and says so, when the template's has no key here", async () => {
    const { create } = install();
    const withModel = { ...template, model: { providerId: "google", modelId: "gemini" } };

    const result = await createWispFromTemplate(withModel, [], create);

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: null }));
    expect(result).toMatchObject({ notices: [expect.stringContaining("uses your default model")] });
  });

  it("never gives the access a template asks for, and says it asked", async () => {
    const { api, create } = install();
    const asking: WispTemplate = {
      ...template,
      access: { allowEverything: true, plugins: [{ pluginId: "linear", access: "write" }] },
    };

    const result = await createWispFromTemplate(asking, [], create);

    expect(result).toMatchObject({ notices: ["Atlas asks for more access. Turn on what you want in its Access tab."] });
    expect(api.saveWispToolPolicy).not.toHaveBeenCalled();
    expect(api.saveWispPluginAccess).not.toHaveBeenCalled();
    expect(api.saveWispMcpAccess).not.toHaveBeenCalled();
  });

  it("creates a Wisp that runs commands without them where there is no container program", async () => {
    const { api, create } = install({ runtime: { available: false, message: "No Docker." } });
    const code: WispTemplate = { ...template, setup: { executionMode: "container" } };

    const result = await createWispFromTemplate(code, [], create);

    expect(api.saveWispExecution).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "created", notices: [expect.stringContaining("Docker or Podman")] });
  });

  it("turns commands on where a container program is available", async () => {
    const { api, create } = install();

    await createWispFromTemplate({ ...template, setup: { executionMode: "container" } }, [], create);

    expect(api.saveWispExecution).toHaveBeenCalledWith(expect.objectContaining({ mode: "container" }));
  });

  it.each([
    ["unlimited", null, "instead of an unlimited one"],
    ["too large for the disk", 2 * 1024 ** 3, "no room"],
  ])("keeps the default workspace when the template's is %s", async (_case, quotaBytes, notice) => {
    const { api, create } = install({ maxQuotaBytes: 1024 ** 3 });

    const result = await createWispFromTemplate({ ...template, setup: { quotaBytes } }, [], create);

    expect(api.setWorkspaceQuota).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notices: [expect.stringContaining(notice)] });
  });

  it("reports a skill it could not add, with the Wisp already made", async () => {
    const { create } = install({ importOk: false });

    expect(await createWispFromTemplate(template, [], create)).toMatchObject({
      status: "created",
      notices: [expect.stringContaining("the brief skill (Bad skill.)")],
    });
  });

  it("says when the Wisp could not be created", async () => {
    const { api, create } = install();
    create.mockResolvedValueOnce(null as never);

    expect(await createWispFromTemplate(template, [], create)).toMatchObject({ status: "failed" });
    expect(api.importSkill).not.toHaveBeenCalled();
  });
});
