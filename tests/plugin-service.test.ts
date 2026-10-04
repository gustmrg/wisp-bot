import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginService } from "../electron/backend/plugin-service.js";
import type { PluginAdapter, PluginToolSpec } from "../electron/backend/plugin-types.js";
import type { EncryptionService } from "../electron/backend/encrypted-credential-store.js";
import { WispBackendError } from "../electron/backend/backend-error.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-plugins-"));
  directories.push(dataDirectory);
  const encryption: EncryptionService = {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
    decrypt: (value) => value.toString().split("").reverse().join(""),
  };
  const execute = vi.fn(async () => "Provider result");
  const executeFirecrawl = vi.fn(async () => "Firecrawl result");
  const testConnection = vi.fn(async () => "Connected");
  const authorize = vi.fn(async () => undefined);
  const sessions = new Map([
    ["one", "session-one"],
    ["two", "session-two"],
  ]);
  const spec = (name: string, access: "read" | "write"): PluginToolSpec => ({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false } as PluginToolSpec["parameters"],
    access,
    summarize: () => "Update issue ABC-1",
    execute,
  });
  const adapters: PluginAdapter[] = [
    { id: "web-search", tools: [spec("web_search", "read")], testConnection },
    { id: "linear", tools: [spec("linear_get_issue", "read"), spec("linear_update_issue", "write")], testConnection },
    {
      id: "firecrawl",
      tools: [
        { ...spec("web_search", "read"), execute: executeFirecrawl },
        { ...spec("web_read", "read"), execute: executeFirecrawl },
      ],
      testConnection,
    },
  ];
  const options = {
    dataDirectory,
    encryption,
    authorizationBroker: { authorize },
    adapters,
    resolveWisp: (id: string) => {
      const sessionId = sessions.get(id);
      if (!sessionId) throw new WispBackendError("not_found", "Wisp not found.");
      return sessionId;
    },
  };
  const service = new PluginService(options);
  await service.load();
  const connect = async () => {
    await service.save({ pluginId: "linear", enabled: true, apiKey: "secret-linear-key" });
  };
  const grant = (access: "none" | "read" | "write", conversationId = "one") =>
    service.saveAccess({ ...service.getAccess({ conversationId }), grants: [{ pluginId: "linear", access }] });
  const call = (name: string, conversationId = "one", signal?: AbortSignal) =>
    service
      .getTools(conversationId)
      .find((tool) => tool.name === name)!
      .execute("tool-1", {}, signal, undefined, {} as never);
  return {
    service,
    options,
    connect,
    grant,
    call,
    execute,
    executeFirecrawl,
    authorize,
    testConnection,
    sessions,
    dataDirectory,
  };
}

describe("plugin service", () => {
  it("exposes one search capability, prefers authorized Brave and routes Firecrawl-only Wisps independently", async () => {
    const { service, call, execute, executeFirecrawl, authorize } = await setup();
    await service.save({ pluginId: "web-search", enabled: true, apiKey: "brave-key" });
    await service.save({ pluginId: "firecrawl", enabled: true, apiKey: "firecrawl-key" });
    expect(await service.getActiveToolNames("one")).toEqual([]);
    expect(service.getTools("one").filter(({ name }) => name === "web_search")).toHaveLength(1);
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [
        { pluginId: "web-search", access: "read" },
        { pluginId: "firecrawl", access: "read" },
      ],
    });
    await service.saveAccess({
      ...service.getAccess({ conversationId: "two" }),
      grants: [{ pluginId: "firecrawl", access: "read" }],
    });
    expect(await service.getActiveToolNames("one")).toEqual(["web_search", "web_read"]);
    expect((await service.getSnapshot("two")).activeNames).toEqual(["web_search", "web_read"]);
    await call("web_search");
    expect(execute).toHaveBeenCalledWith("brave-key", {}, expect.any(AbortSignal));
    expect(executeFirecrawl).not.toHaveBeenCalled();
    await call("web_search", "two");
    await call("web_read");
    expect(executeFirecrawl).toHaveBeenCalledTimes(2);
    expect(executeFirecrawl).toHaveBeenCalledWith("firecrawl-key", {}, expect.any(AbortSignal));
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refreshes provider revisions and prevents revoked or stale web calls", async () => {
    const { service, call, execute, executeFirecrawl, sessions } = await setup();
    await service.save({ pluginId: "web-search", enabled: true, apiKey: "brave-key" });
    await service.save({ pluginId: "firecrawl", enabled: true, apiKey: "firecrawl-key" });
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [
        { pluginId: "web-search", access: "read" },
        { pluginId: "firecrawl", access: "read" },
      ],
    });
    const before = await service.getSnapshot("one");
    const staleTool = service.getTools("one").find(({ name }) => name === "web_search")!;
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [{ pluginId: "firecrawl", access: "read" }],
    });
    const after = await service.getSnapshot("one");
    expect(after.activeNames).toEqual(before.activeNames);
    expect(after.revision).not.toBe(before.revision);
    await call("web_search");
    expect(execute).not.toHaveBeenCalled();
    expect(executeFirecrawl).toHaveBeenCalledTimes(1);
    await service.save({ pluginId: "firecrawl", enabled: true, apiKey: "replacement-key" });
    await expect(call("web_read")).rejects.toMatchObject({ code: "tool_blocked" });
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [{ pluginId: "firecrawl", access: "read" }],
    });
    sessions.set("one", "replacement-session");
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [{ pluginId: "firecrawl", access: "read" }],
    });
    await expect(staleTool.execute("stale", {}, undefined, undefined, {} as never)).rejects.toMatchObject({
      code: "tool_blocked",
    });
    expect(executeFirecrawl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed search on another paid provider", async () => {
    const { service, call, execute, executeFirecrawl } = await setup();
    await service.save({ pluginId: "web-search", enabled: true, apiKey: "brave-key" });
    await service.save({ pluginId: "firecrawl", enabled: true, apiKey: "firecrawl-key" });
    await service.saveAccess({
      ...service.getAccess({ conversationId: "one" }),
      grants: [
        { pluginId: "web-search", access: "read" },
        { pluginId: "firecrawl", access: "read" },
      ],
    });
    execute.mockRejectedValueOnce(new Error("private provider failure"));
    await expect(call("web_search")).rejects.toMatchObject({ code: "internal_error" });
    expect(executeFirecrawl).not.toHaveBeenCalled();
  });

  it("preserves existing connections and grants when loading settings without Firecrawl", async () => {
    const { service, connect, grant, options, dataDirectory } = await setup();
    await connect();
    await grant("read");
    const file = path.join(dataDirectory, "plugins.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    delete state.enabled.firecrawl;
    await writeFile(file, JSON.stringify(state));
    const reopened = new PluginService(options);
    await reopened.load();
    expect(await reopened.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
    expect((await reopened.getView()).plugins.find(({ id }) => id === "firecrawl")).toMatchObject({
      enabled: false,
      configured: false,
    });
    expect(() =>
      service.saveAccess({
        ...service.getAccess({ conversationId: "one" }),
        grants: [{ pluginId: "firecrawl", access: "write" }],
      }),
    ).toThrow();
  });

  it("starts denied and connecting does not grant tools; persists independent Wisp grants without plaintext secrets", async () => {
    const { service, options, connect, grant, call, execute, dataDirectory } = await setup();
    expect((await service.getView()).plugins.every((plugin) => !plugin.enabled && !plugin.configured)).toBe(true);
    await connect();
    expect(await service.getActiveToolNames("one")).toEqual([]);
    await grant("read");
    expect(await service.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
    expect(await service.getActiveToolNames("two")).toEqual([]);
    await expect(call("linear_get_issue", "two")).rejects.toMatchObject({ code: "tool_blocked" });
    await expect(call("linear_update_issue")).rejects.toMatchObject({ code: "tool_blocked" });
    expect(execute).not.toHaveBeenCalled();
    await call("linear_get_issue");
    expect(execute).toHaveBeenCalledWith("secret-linear-key", {}, expect.any(AbortSignal));
    expect(JSON.stringify(await service.getView())).not.toContain("secret-linear-key");
    expect(await readFile(path.join(dataDirectory, "plugins.json"), "utf8")).not.toContain("secret-linear-key");
    expect(await readFile(path.join(dataDirectory, "plugin-credentials.enc.json"), "utf8")).not.toContain(
      "secret-linear-key",
    );
    const reopened = new PluginService(options);
    await reopened.load();
    expect(await reopened.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
    expect(await reopened.getActiveToolNames("two")).toEqual([]);
  });

  it("requires approval for allowed writes and blocks a revoked grant while approval is pending", async () => {
    const { connect, grant, call, authorize, execute } = await setup();
    await connect();
    await grant("write");
    let release!: () => void;
    authorize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = call("linear_update_issue");
    await vi.waitFor(() => expect(authorize).toHaveBeenCalled());
    expect(execute).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ category: "external_write", scope: { kind: "integration", value: "Linear" } }),
      expect.any(AbortSignal),
    );
    await grant("none");
    release();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(execute).not.toHaveBeenCalled();
    await grant("write");
    await call("linear_update_issue");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("disabling cancels a running request; removing or replacing keys clears every previous account grant", async () => {
    const { service, connect, grant, call, execute } = await setup();
    await connect();
    await grant("read");
    await grant("write", "two");
    execute.mockImplementationOnce(
      async (_key?: string, _params?: unknown, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("secret-provider-error")), { once: true }),
        ),
    );
    const pending = call("linear_get_issue");
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await service.save({ pluginId: "linear", enabled: false });
    await rejected;
    expect(await service.getActiveToolNames("one")).toEqual([]);
    await service.save({ pluginId: "linear", enabled: true });
    expect(await service.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
    await service.save({ pluginId: "linear", enabled: true, apiKey: "other-account-key" });
    expect(await service.getActiveToolNames("one")).toEqual([]);
    expect(await service.getActiveToolNames("two")).toEqual([]);
    await grant("read");
    await service.remove({ pluginId: "linear" });
    expect((await service.getView()).plugins.find(({ id }) => id === "linear")).toMatchObject({
      enabled: false,
      configured: false,
    });
    await connect();
    expect(await service.getActiveToolNames("one")).toEqual([]);
  });

  it("never carries access to a recreated Wisp and refuses circles or absent Wisps", async () => {
    const { service, connect, grant, sessions, execute } = await setup();
    await connect();
    await grant("write");
    const oldTool = service.getTools("one").find(({ name }) => name === "linear_get_issue")!;
    sessions.set("one", "replacement-session");
    expect(await service.getActiveToolNames("one")).toEqual([]);
    await grant("read");
    await expect(oldTool.execute("stale-tool", {}, undefined, undefined, {} as never)).rejects.toMatchObject({
      code: "tool_blocked",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(() => service.getAccess({ conversationId: "circle" })).toThrow("Wisp not found");
  });

  it("validates configuration, rejects unavailable grants and keeps secrets out of unexpected errors", async () => {
    const { service, options, connect, grant, call, execute, testConnection } = await setup();
    await expect(grant("read")).rejects.toMatchObject({ code: "configuration_required" });
    for (const request of [
      { pluginId: "unknown", enabled: true },
      { pluginId: "linear", enabled: true, apiKey: "\nsecret" },
      { pluginId: "linear", enabled: true, arbitraryEndpoint: "https://example.com" },
    ]) {
      expect(() => service.save(request)).toThrow();
    }
    expect(() =>
      service.saveAccess({
        ...service.getAccess({ conversationId: "one" }),
        grants: [{ pluginId: "web-search", access: "write" }],
      }),
    ).toThrow();
    expect(() =>
      service.saveAccess({
        ...service.getAccess({ conversationId: "one" }),
        grants: [{ pluginId: "linear", access: ["read"] }],
      }),
    ).toThrow();
    expect(() =>
      service.saveAccess({
        ...service.getAccess({ conversationId: "one" }),
        grants: [
          { pluginId: "linear", access: "read" },
          { pluginId: "linear", access: "none" },
        ],
      }),
    ).toThrow();
    await service.testConnection({ pluginId: "linear", apiKey: "test-key" });
    expect(testConnection).toHaveBeenCalledWith("test-key", expect.any(AbortSignal));
    expect((await service.getView()).plugins.every(({ configured }) => !configured)).toBe(true);
    await connect();
    await grant("read");
    execute.mockRejectedValueOnce(new Error("secret-linear-key provider payload"));
    await expect(call("linear_get_issue")).rejects.toMatchObject({
      message: "The plugin could not complete the request.",
    });
    const insecure = new PluginService({ ...options, encryption: { ...options.encryption, isAvailable: () => false } });
    await expect(insecure.save({ pluginId: "linear", enabled: true, apiKey: "new-key" })).rejects.toMatchObject({
      code: "secure_storage_unavailable",
    });
  });

  it("recovers corrupt settings with no privileges", async () => {
    const { service, connect, grant, dataDirectory, options } = await setup();
    await connect();
    await grant("write");
    await writeFile(
      path.join(dataDirectory, "plugins.json"),
      '{"schemaVersion":1,"enabled":{"linear":true},"grants":{}}',
    );
    const recovered = new PluginService(options);
    await recovered.load();
    expect(await recovered.getActiveToolNames("one")).toEqual([]);
    expect(recovered.getAccess({ conversationId: "one" }).grants.every(({ access }) => access === "none")).toBe(true);
    service.dispose();
    await expect(service.getActiveToolNames("one")).rejects.toMatchObject({ code: "disposed" });
  });

  it("rejects old access forms after key replacement and after persisted revocation", async () => {
    const { service, options, connect, grant } = await setup();
    await connect();
    await grant("write");
    const beforeRotation = service.getAccess({ conversationId: "one" });
    expect(beforeRotation.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(beforeRotation.revision).not.toContain("session-one");
    await service.save({ pluginId: "linear", enabled: true, apiKey: "replacement-account" });
    await expect(service.saveAccess(beforeRotation)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Reload access settings"),
    });
    expect(await service.getActiveToolNames("one")).toEqual([]);

    await grant("write");
    const beforeRevocation = service.getAccess({ conversationId: "one" });
    await grant("none");
    const reopened = new PluginService(options);
    await reopened.load();
    expect(reopened.getAccess({ conversationId: "one" }).revision).toBe(
      service.getAccess({ conversationId: "one" }).revision,
    );
    await expect(reopened.saveAccess(beforeRevocation)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await reopened.getActiveToolNames("one")).toEqual([]);
    await reopened.saveAccess({
      ...reopened.getAccess({ conversationId: "one" }),
      grants: [{ pluginId: "linear", access: "read" }],
    });
    expect(await reopened.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
  });

  it("binds an access form to its Wisp session and serializes concurrent updates", async () => {
    const { service, connect, grant, sessions } = await setup();
    await connect();
    await grant("write");
    const oldForm = service.getAccess({ conversationId: "one" });
    expect(service.getAccess({ conversationId: "two" }).revision).not.toBe(oldForm.revision);
    sessions.set("one", "replacement-session");
    await expect(service.saveAccess(oldForm)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await service.getActiveToolNames("one")).toEqual([]);

    const current = service.getAccess({ conversationId: "one" });
    const results = await Promise.allSettled([
      service.saveAccess({ ...current, grants: [{ pluginId: "linear", access: "write" }] }),
      service.saveAccess({ ...current, grants: [] }),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "invalid_request" } });
    expect(await service.getActiveToolNames("one")).toEqual(["linear_get_issue", "linear_update_issue"]);
  });

  it("requires a well-formed revision on every access save", async () => {
    const { service } = await setup();
    for (const revision of [undefined, "", "session-one", "f".repeat(63), "f".repeat(65), 1]) {
      expect(() => service.saveAccess({ conversationId: "one", revision, grants: [] })).toThrow();
    }
  });

  it("never reads credentials without eligible access and tolerates corrupt plugin secrets", async () => {
    const { service, options, connect, grant, dataDirectory } = await setup();
    await connect();
    await grant("write");
    const decrypt = vi.spyOn(options.encryption, "decrypt").mockImplementation(() => {
      throw new Error("unreadable keychain");
    });
    await expect(service.getActiveToolNames("two")).resolves.toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
    await expect(service.getActiveToolNames("one")).resolves.toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(1);
    decrypt.mockClear();
    await grant("read");
    await grant("none");
    expect(decrypt).not.toHaveBeenCalled();
    await writeFile(path.join(dataDirectory, "plugin-credentials.enc.json"), "{broken");
    await expect(service.getActiveToolNames("one")).resolves.toEqual([]);
    await expect(service.getActiveToolNames("missing")).rejects.toMatchObject({ code: "not_found" });
    service.dispose();
    await expect(service.getActiveToolNames("one")).rejects.toMatchObject({ code: "disposed" });
  });

  it("disables plugins even when stored credentials cannot be read and reports the problem", async () => {
    const { service, options, connect, grant } = await setup();
    await connect();
    await grant("write");
    vi.spyOn(options.encryption, "decrypt").mockImplementation(() => {
      throw new Error("secret credential failure");
    });
    const view = await service.save({ pluginId: "linear", enabled: false });
    expect(view.plugins.find(({ id }) => id === "linear")).toMatchObject({ enabled: false, configured: false });
    expect(view.credentialError).toContain("credentials are unavailable");
    expect(JSON.stringify(view)).not.toContain("secret credential failure");
    await expect(service.getActiveToolNames("one")).resolves.toEqual([]);
    await grant("read");
    await grant("none");
    const reopened = new PluginService(options);
    await reopened.load();
    expect(reopened.getAccess({ conversationId: "one" }).grants.every(({ access }) => access === "none")).toBe(true);
  });
});
