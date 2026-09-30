import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getToolMetadata, resetDynamicToolMetadata } from "../shared/tool-catalog.js";
import { McpService } from "../electron/backend/mcp-service.js";
import type { McpConnection, McpConnectionAuth, McpConnectionOptions } from "../electron/backend/mcp-bridge.js";
import type { EncryptionService } from "../electron/backend/encrypted-credential-store.js";
import type { ToolAuthorizationBroker } from "../electron/backend/tool-authorization-broker.js";

const encryption: EncryptionService = {
  isAvailable: () => encryptionAvailable,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
};
let encryptionAvailable = true;

interface ConnectionFixture {
  outcome: "connected" | "needs_sign_in" | Error;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  result?: unknown;
}

class FakeConnection implements McpConnection {
  connects = 0;
  closed = 0;
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(private readonly fixture: ConnectionFixture) {}

  get connectionStatus(): "connected" | "idle" {
    return this.connects > 0 && this.closed === 0 ? "connected" : "idle";
  }

  async connect(_endpoint: string, _auth: McpConnectionAuth): Promise<"connected" | "needs_sign_in"> {
    this.connects += 1;
    const outcome = this.fixture.outcome;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  async listTools() {
    return this.fixture.tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (this.fixture.result instanceof Error) throw this.fixture.result;
    return this.fixture.result ?? { content: [{ type: "text", text: `ran ${name}` }] };
  }

  async close() {
    this.closed += 1;
  }
}

interface ServiceOverrides {
  authorizationBroker?: Pick<ToolAuthorizationBroker, "authorize">;
}

const TOOL = {
  name: "search",
  description: "Search things",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

let serverCounter = 0;

async function createService(
  { authorizationBroker }: ServiceOverrides = {},
  connections: ReadonlyArray<ConnectionFixture> = [],
) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-mcp-"));
  const created: FakeConnection[] = [];
  const broker = authorizationBroker ?? { authorize: vi.fn(async () => undefined) };
  const service = new McpService({
    dataDirectory,
    encryption,
    authorizationBroker: broker,
    resolveWisp: (conversationId) => `session-${conversationId}`,
    openExternal: vi.fn(async () => undefined),
    createConnection: (_options: McpConnectionOptions): McpConnection => {
      const fixture = connections[created.length] ?? { outcome: new Error("no fixture"), tools: [] };
      const connection = new FakeConnection(fixture);
      created.push(connection);
      return connection;
    },
  });
  await service.load();
  return { service, dataDirectory, created, broker };
}

async function addServer(
  service: McpService,
  config: { endpoint?: string; authMode?: "none" | "header" | "oauth"; enabled?: boolean } = {},
) {
  serverCounter += 1;
  const view = await service.save({
    name: `Server ${serverCounter}`,
    endpoint: config.endpoint ?? `https://server-${serverCounter}.example.com/mcp`,
    authMode: config.authMode ?? "none",
    enabled: config.enabled ?? true,
  });
  const server = view.servers.find(({ name }) => name === `Server ${serverCounter}`)!;
  return { serverId: server.serverId, server };
}

/** Re-saves an existing server with only the enablement flag changed. */
async function setEnabled(
  service: McpService,
  server: { serverId: string; name: string; endpoint: string; authMode: "none" | "header" | "oauth" },
  enabled: boolean,
) {
  return service.save({
    serverId: server.serverId,
    name: server.name,
    endpoint: server.endpoint,
    authMode: server.authMode,
    enabled,
  });
}

async function grantAccess(service: McpService, conversationId: string, serverId: string) {
  const access = service.getAccess({ conversationId });
  // Grant forms carry every server; only the target server's entry changes.
  const grants = access.grants.map((grant) =>
    grant.serverId === serverId ? { ...grant, access: "use_with_approval" as const } : grant,
  );
  return service.saveAccess({ conversationId, revision: access.revision, grants });
}

/** Parses outside the mutation queue reject synchronously; normalize to promises. */
function saveAsync(service: McpService, payload: Record<string, unknown>) {
  return Promise.resolve().then(() => service.save(payload));
}

type ExecutableDefinition = {
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }>;
};

async function firstDefinition(service: McpService, conversationId = "wisp-a"): Promise<ExecutableDefinition> {
  const snapshot = await service.getSnapshot(conversationId);
  return snapshot.definitions[0] as unknown as ExecutableDefinition;
}

afterEach(() => {
  resetDynamicToolMetadata();
  encryptionAvailable = true;
});

describe("McpService", () => {
  it("adds a server, persists it, and restores it on reload", async () => {
    const { service, dataDirectory } = await createService();
    const { serverId } = await addServer(service);

    const restored = new McpService({
      dataDirectory,
      encryption,
      authorizationBroker: { authorize: vi.fn() },
      resolveWisp: (id) => `session-${id}`,
      openExternal: vi.fn(async () => undefined),
    });
    await restored.load();
    const view = await restored.getView();
    expect(view.servers).toHaveLength(1);
    expect(view.servers[0]?.serverId).toBe(serverId);
    expect(view.servers[0]?.state).toBe("configured");
  });

  it("recovers from a corrupt store with every server gone", async () => {
    const { service, dataDirectory } = await createService();
    await addServer(service);
    await writeFile(path.join(dataDirectory, "mcp-servers.json"), "{not json", "utf8");

    const recovered = new McpService({
      dataDirectory,
      encryption,
      authorizationBroker: { authorize: vi.fn() },
      resolveWisp: (id) => `session-${id}`,
      openExternal: vi.fn(async () => undefined),
    });
    await recovered.load();
    expect((await recovered.getView()).servers).toEqual([]);
    const files = await readdir(dataDirectory);
    expect(files.some((file) => file.startsWith("mcp-servers.json.corrupt-"))).toBe(true);
  });

  it("rejects local process configuration and non-HTTPS endpoints at the boundary", async () => {
    const { service } = await createService();
    await expect(
      saveAsync(service, { name: "Local", endpoint: "https://x.example.com", authMode: "none", command: "node" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      saveAsync(service, { name: "Insecure", endpoint: "http://x.example.com/mcp", authMode: "none" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      saveAsync(service, { name: "Userinfo", endpoint: "https://user:pass@example.com/mcp", authMode: "none" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      saveAsync(service, { name: "Env", endpoint: "https://x.example.com/mcp", authMode: "none", env: { FOO: "1" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("denies every Wisp by default and requires an enabled connection before granting", async () => {
    const { service } = await createService();
    const { serverId, server } = await addServer(service, { enabled: false });

    const access = service.getAccess({ conversationId: "wisp-a" });
    expect(access.grants).toEqual([{ serverId, access: "none" }]);

    await expect(
      service.saveAccess({
        conversationId: "wisp-a",
        revision: access.revision,
        grants: [{ serverId, access: "use_with_approval" }],
      }),
    ).rejects.toMatchObject({ code: "configuration_required" });

    await setEnabled(service, server, true);
    await grantAccess(service, "wisp-a", serverId);
    expect(service.getAccess({ conversationId: "wisp-a" }).grants).toEqual([{ serverId, access: "use_with_approval" }]);
  });

  it("rejects stale access saves but keeps the revision scoped to the Wisp's granted servers", async () => {
    const connections = [{ outcome: "connected" as const, tools: [TOOL] }];
    const { service } = await createService({}, connections);
    const { serverId } = await addServer(service);
    const unrelated = await addServer(service, { enabled: false });
    await grantAccess(service, "wisp-a", serverId);
    const revisionBefore = service.getAccess({ conversationId: "wisp-a" }).revision;

    // An unrelated server's configuration change must not invalidate Wisp A.
    await setEnabled(service, unrelated.server, unrelated.server.enabled);
    expect(service.getAccess({ conversationId: "wisp-a" }).revision).toBe(revisionBefore);

    // Another Wisp's grants must not invalidate Wisp A either.
    const other = await addServer(service);
    await grantAccess(service, "wisp-b", other.serverId);
    expect(service.getAccess({ conversationId: "wisp-a" }).revision).toBe(revisionBefore);

    // A stale save is still rejected.
    await expect(
      service.saveAccess({
        conversationId: "wisp-a",
        revision: "0".repeat(64),
        grants: [{ serverId, access: "none" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    // Changing the granted server's endpoint does invalidate the form.
    await service.save({
      serverId,
      name: "Server 1",
      endpoint: "https://moved.example.com/mcp",
      authMode: "none",
      enabled: true,
    });
    expect(service.getAccess({ conversationId: "wisp-a" }).revision).not.toBe(revisionBefore);
  });

  it("revokes grants when the endpoint or credential changes", async () => {
    const { service } = await createService();
    const { serverId } = await addServer(service);
    await grantAccess(service, "wisp-a", serverId);

    await service.save({
      serverId,
      name: "Server 1",
      endpoint: "https://elsewhere.example.com/mcp",
      authMode: "none",
      enabled: true,
    });

    expect(service.getAccess({ conversationId: "wisp-a" }).grants).toEqual([{ serverId, access: "none" }]);
  });

  it("exposes only granted enabled servers in the snapshot with collision-free aliases", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [{ ...TOOL, description: "Other search" }] },
    ];
    const { service } = await createService({}, connections);
    const first = await addServer(service);
    const second = await addServer(service);
    await service.refreshTools({ serverId: first.serverId });
    await service.refreshTools({ serverId: second.serverId });

    const none = await service.getSnapshot("wisp-a");
    expect(none.definitions).toEqual([]);
    expect(none.activeNames).toEqual([]);

    await grantAccess(service, "wisp-a", first.serverId);
    const partial = await service.getSnapshot("wisp-a");
    expect(partial.activeNames).toHaveLength(1);

    await grantAccess(service, "wisp-a", second.serverId);
    const both = await service.getSnapshot("wisp-a");
    expect(both.definitions).toHaveLength(2);
    const aliases = both.activeNames as string[];
    expect(new Set(aliases).size).toBe(2);
    expect(aliases[0]).not.toBe(aliases[1]);
    // Dynamic metadata is registered for display and authorization labels.
    for (const alias of aliases) expect(getToolMetadata(alias)?.category).toBe("integration_call");
    // Revision tracks definition fingerprints, not just names.
    expect(both.revision).not.toBe(partial.revision);
  });

  it("keeps distinct colliding tool names dispatchable within one server", async () => {
    const connections = [
      {
        outcome: "connected" as const,
        tools: [
          { ...TOOL, name: "search.users" },
          { ...TOOL, name: "search_users", description: "Users search" },
        ],
      },
      { outcome: "connected" as const, tools: [] },
    ];
    const { service } = await createService({}, connections);
    const { serverId } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);

    const snapshot = await service.getSnapshot("wisp-a");
    expect(snapshot.definitions).toHaveLength(2);
    const aliases = snapshot.activeNames as string[];
    expect(new Set(aliases).size).toBe(2);
    // Both wrappers dispatch their own original name.
    const first = await firstDefinition(service).then((definition) => definition.execute("c1", { query: "x" }));
    expect(first.content[0]?.text).toMatch(/ran search/);
  });

  it("shares one pooled connection between concurrent calls to the same server", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [TOOL] },
    ];
    const { service, created } = await createService({}, connections);
    const { serverId } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    const definition = await firstDefinition(service);
    const connectionsBefore = created.length;

    // Pi executes tool calls from one turn in parallel by default.
    await Promise.all([definition.execute("c1", { query: "a" }), definition.execute("c2", { query: "b" })]);

    expect(created.length - connectionsBefore).toBe(1);
    expect(created.at(-1)?.calls.map(({ args }) => args.query)).toEqual(["a", "b"]);
    service.dispose();
    expect(created.at(-1)?.closed).toBe(1);
  });

  it("blocks dispatch when the reviewed tool changed while approval was pending", async () => {
    const changedTool = { ...TOOL, description: "Search things, differently" };
    let refreshDuringApproval: (() => Promise<void>) | undefined;
    const { service, created } = await createService(
      {
        authorizationBroker: {
          authorize: vi.fn(async () => {
            await refreshDuringApproval?.();
          }),
        },
      },
      [
        { outcome: "connected" as const, tools: [TOOL] },
        { outcome: "connected" as const, tools: [changedTool] },
      ],
    );
    const { serverId } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    // The wrapper was created from the original snapshot; the refresh during
    // approval replaces the fingerprint for the same tool name.
    const staleDefinition = await firstDefinition(service);
    refreshDuringApproval = () => service.refreshTools({ serverId });

    await expect(staleDefinition.execute("call-1", { query: "x" })).rejects.toMatchObject({
      code: "tool_blocked",
      message: expect.stringContaining("changed"),
    });
    // No connection was ever pooled or dispatched for the stale call.
    expect(created).toHaveLength(2);
  });

  it("drops tools from the snapshot when the server is disabled and unregisters labels on removal", async () => {
    const connections = [{ outcome: "connected" as const, tools: [TOOL] }];
    const { service } = await createService({}, connections);
    const { serverId, server } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    const alias = (await service.getSnapshot("wisp-a")).activeNames[0]!;
    expect(getToolMetadata(alias)).toBeDefined();

    await setEnabled(service, server, false);
    expect((await service.getSnapshot("wisp-a")).definitions).toEqual([]);
    // Disabling keeps grants.
    expect(service.getAccess({ conversationId: "wisp-a" }).grants).toEqual([{ serverId, access: "use_with_approval" }]);

    await service.remove({ serverId });
    expect(getToolMetadata(alias)).toBeUndefined();
    expect(service.getAccess({ conversationId: "wisp-a" }).grants).toEqual([]);
  });

  it("authorizes and dispatches calls with the original tool name and a bounded preview", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [TOOL] },
    ];
    const authorize = vi.fn(async () => undefined);
    const { service, created } = await createService({ authorizationBroker: { authorize } }, connections);
    const { serverId, server } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);

    const snapshot = await service.getSnapshot("wisp-a");
    const definition = await firstDefinition(service);
    const result = await definition.execute("call-1", { query: "findings" });

    expect(result.content[0]?.text).toBe("ran search");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "wisp-a",
        toolCallId: "call-1",
        toolName: snapshot.activeNames[0],
        category: "integration_call",
        scope: { kind: "integration", value: server.name },
      }),
      expect.anything(),
    );
    const summary = (authorize.mock.calls[0]?.[0] as { summary: string }).summary;
    expect(summary).toContain("query: findings");
    // Dispatch uses the server's original tool name, never the alias.
    expect(created.at(-1)!.calls).toEqual([{ name: "search", args: { query: "findings" } }]);
  });

  it("redacts secret-like argument keys in the approval summary", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [TOOL] },
    ];
    let capturedSummary = "";
    const { service } = await createService(
      {
        authorizationBroker: {
          authorize: vi.fn(async (action: { summary: string }) => {
            capturedSummary = action.summary;
          }),
        },
      },
      connections,
    );
    const { serverId } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    const redactDefinition = await firstDefinition(service);
    await redactDefinition.execute("call-1", { query: "x", apiToken: "super-secret" });
    expect(capturedSummary).toContain("apiToken: [redacted]");
    expect(capturedSummary).toContain("query: x");
    expect(capturedSummary).not.toContain("super-secret");
  });

  it("surfaces MCP isError results as failed calls", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      {
        outcome: "connected" as const,
        tools: [TOOL],
        result: { isError: true, content: [{ type: "text", text: "upstream broke" }] },
      },
    ];
    const { service, created } = await createService({}, connections);
    const { serverId } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    const errorDefinition = await firstDefinition(service);
    await expect(errorDefinition.execute("call-1", { query: "x" })).rejects.toMatchObject({
      code: "internal_error",
      message: expect.stringContaining("upstream broke"),
    });
    expect(created.at(-1)!.calls).toHaveLength(1);
  });

  it("blocks calls when access is revoked while approval is pending", async () => {
    const connections = [
      { outcome: "connected" as const, tools: [TOOL] },
      { outcome: "connected" as const, tools: [TOOL] },
    ];
    let disableDuringApproval: (() => Promise<void>) | undefined;
    const { service, created, broker } = await createService(
      {
        authorizationBroker: {
          authorize: vi.fn(async () => {
            await disableDuringApproval?.();
          }),
        },
      },
      connections,
    );
    const { serverId, server } = await addServer(service);
    await service.refreshTools({ serverId });
    await grantAccess(service, "wisp-a", serverId);
    disableDuringApproval = () => setEnabled(service, server, false);

    const blockedDefinition = await firstDefinition(service);
    await expect(blockedDefinition.execute("call-1", { query: "x" })).rejects.toMatchObject({
      code: "tool_blocked",
    });
    expect(broker.authorize).toHaveBeenCalled();
    expect(created.at(-1)!.calls).toHaveLength(0);
  });

  it("requires sign-in before refreshing or granting an oauth server without tokens", async () => {
    const { service } = await createService({}, [{ outcome: "needs_sign_in", tools: [] }]);
    const { serverId } = await addServer(service, { authMode: "oauth" });
    let view = await service.getView();
    expect(view.servers[0]?.state).toBe("needs_sign_in");

    await expect(service.refreshTools({ serverId })).rejects.toMatchObject({ code: "configuration_required" });

    const access = service.getAccess({ conversationId: "wisp-a" });
    await expect(
      service.saveAccess({
        conversationId: "wisp-a",
        revision: access.revision,
        grants: [{ serverId, access: "use_with_approval" }],
      }),
    ).rejects.toMatchObject({ code: "configuration_required" });
    view = await service.getView();
    expect(view.servers[0]?.state).toBe("needs_sign_in");
  });

  it("tests draft connections without granting access or persisting snapshots", async () => {
    const { service, created } = await createService({}, [{ outcome: "connected" as const, tools: [TOOL] }]);
    const { server, serverId } = await addServer(service, { enabled: false });
    const result = await service.testConnection({
      serverId,
      endpoint: server.endpoint,
      authMode: "none",
    });
    expect(result.message).toContain("1 tool");
    const view = await service.getView();
    expect(view.servers[0]?.tools).toHaveLength(0);
    expect(created[0]?.closed).toBe(1);
  });

  it("blocks secret saves when secure storage is unavailable but allows unauthenticated servers", async () => {
    const { service } = await createService();
    encryptionAvailable = false;
    await expect(
      service.save({
        name: "Header server",
        endpoint: "https://h.example.com/mcp",
        authMode: "header",
        headerName: "Authorization",
        headerValue: "Bearer x",
      }),
    ).rejects.toMatchObject({ code: "secure_storage_unavailable" });
    await service.save({ name: "Open server", endpoint: "https://o.example.com/mcp", authMode: "none" });
    expect((await service.getView()).servers).toHaveLength(1);
  });

  it("stores header secrets in the dedicated MCP store and never returns them in views", async () => {
    const { service, dataDirectory } = await createService();
    await service.save({
      name: "Header server",
      endpoint: "https://h.example.com/mcp",
      authMode: "header",
      headerName: "X-Api-Key",
      headerValue: "sekrit-value",
    });
    const view = await service.getView();
    expect(JSON.stringify(view)).not.toContain("sekrit-value");
    const secretsFile = JSON.parse(await readFile(path.join(dataDirectory, "mcp-credentials.enc.json"), "utf8")) as {
      schemaVersion: number;
      payload: string;
    };
    expect(secretsFile.schemaVersion).toBe(1);
    const plaintext = Buffer.from(secretsFile.payload, "base64").toString("utf8");
    expect(plaintext).toContain("sekrit-value");
  });
});
