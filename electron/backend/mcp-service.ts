import { readFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import {
  disambiguateMcpAlias,
  mcpToolAlias,
  type McpAccess,
  type McpAuthMode,
  type McpConnectionResult,
  type McpConnectionState,
  type McpSettingsView,
  type WispMcpAccessView,
} from "../../shared/mcp.js";
import { registerDynamicToolMetadata, unregisterDynamicToolMetadata } from "../../shared/tool-catalog.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import type { EncryptionService } from "./encrypted-credential-store.js";
import {
  McpConnection,
  convertMcpToolResult,
  type McpConnectionAuth,
  type McpConnectionOptions,
  type McpSdkTool,
} from "./mcp-bridge.js";
import { McpOAuthProvider } from "./mcp-oauth.js";
import { McpSecretStore } from "./mcp-secret-store.js";
import type { IntegrationToolSnapshot, SnapshotToolMetadata } from "./integration-tool-source.js";
import {
  invalidMcpRequest,
  MAX_TOOL_DESCRIPTION_CHARACTERS,
  MAX_TOOL_SCHEMA_JSON_BYTES,
  MAX_TOOL_SNAPSHOT_TOOLS,
  mcpRecord,
  parseMcpConversation,
  parseSaveMcpServer,
  parseSaveWispMcpAccess,
  parseTestMcpConnection,
  parseMcpServerRequest,
} from "./mcp-validation.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";

const MAX_ARGUMENT_JSON_BYTES = 200_000;
const MAX_SUMMARY_ARGUMENT_CHARACTERS = 60;
const SECRET_KEY_PATTERN = /token|secret|password|authorization|credential|api[-_]?key/i;

interface McpToolRecord {
  name: string;
  alias: string;
  label: string;
  description: string;
  fingerprint: string;
  inputSchema: unknown;
}

interface McpServerRecord {
  serverId: string;
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  enabled: boolean;
  /** Bumped whenever endpoint, authentication, or account identity changes. */
  configGeneration: number;
  headerName?: string;
  snapshot?: { discoveredAt: string; tools: McpToolRecord[] };
  lastConnection?: { state: "connected" | "unavailable"; at: string; message?: string };
}

interface McpState {
  schemaVersion: 1;
  revision: string;
  servers: Record<string, McpServerRecord>;
  grants: Record<string, Record<string, McpAccess>>;
}

export interface McpServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
  resolveWisp: (conversationId: string) => string;
  openExternal: (url: string) => Promise<void>;
  createConnection?: (options: McpConnectionOptions) => McpConnection;
  createOAuthProvider?: (serverId: string) => McpOAuthProvider;
  /** Observes sanitized settings changes; raw secrets never reach the renderer. */
  onSettingsChanged?: (view: McpSettingsView) => void;
}

interface PoolEntry {
  connection: McpConnection;
  provider?: McpOAuthProvider;
  generation: number;
}

interface ActiveSignIn {
  controller: AbortController;
  provider: McpOAuthProvider;
  /** Set only by an explicit cancel, so its outcome reads as a cancellation. */
  cancelledByUser: boolean;
}

export class McpService {
  private state: McpState = defaultState();
  private readonly filePath: string;
  private readonly secrets: McpSecretStore;
  private mutation = Promise.resolve();
  private disposed = false;
  private readonly running = new Map<
    AbortController,
    { conversationId: string; sessionId: string; serverId: string }
  >();
  private readonly pool = new Map<string, PoolEntry>();
  /** In-flight interactive sign-ins, keyed by server. */
  private readonly activeSignIns = new Map<string, ActiveSignIn>();

  constructor(private readonly options: McpServiceOptions) {
    this.filePath = path.join(options.dataDirectory, "mcp-servers.json");
    this.secrets = new McpSecretStore(path.join(options.dataDirectory, "mcp-credentials.enc.json"), options.encryption);
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(content) > 2_000_000) throw invalidMcpRequest();
      this.state = normalizeState(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Recover with every server disabled and every Wisp denied.
      this.state = defaultState();
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    }
    this.registerSnapshotMetadata();
  }

  async getView(): Promise<McpSettingsView> {
    let headerConfigured = new Set<string>();
    let signedIn = new Set<string>();
    let credentialError: string | undefined;
    try {
      for (const server of Object.values(this.state.servers)) {
        const secret = await this.secrets.read(server.serverId).catch(() => undefined);
        if (secret?.type === "header") headerConfigured.add(server.serverId);
        if (secret?.type === "oauth") signedIn.add(server.serverId);
      }
    } catch {
      credentialError =
        "Saved MCP credentials are unavailable. Connections stay disabled until secure storage can be read again.";
    }
    return {
      secureStorageAvailable: this.secrets.isSecureStorageAvailable(),
      ...(credentialError ? { credentialError } : {}),
      servers: Object.values(this.state.servers)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((server) => ({
          serverId: server.serverId,
          name: server.name,
          endpoint: server.endpoint,
          authMode: server.authMode,
          enabled: server.enabled,
          headerConfigured: headerConfigured.has(server.serverId),
          ...(server.headerName ? { headerName: server.headerName } : {}),
          ...(this.isSignInPending(server.serverId) ? { signInPending: true } : {}),
          state: this.connectionState(server, signedIn.has(server.serverId)),
          lastDiscoveredAt: server.snapshot?.discoveredAt ?? null,
          tools: (server.snapshot?.tools ?? []).map((tool) => ({
            name: tool.name,
            alias: tool.alias,
            label: tool.label,
            description: tool.description,
            fingerprint: tool.fingerprint,
          })),
        })),
    };
  }

  save(value: unknown): Promise<McpSettingsView> {
    const request = parseSaveMcpServer(value);
    return this.enqueue(async () => {
      const next = structuredClone(this.state);
      if (request.serverId) {
        const existing = next.servers[request.serverId];
        if (!existing) throw new WispBackendError("not_found", "This MCP connection no longer exists.");
        const identityChanged =
          existing.endpoint !== request.endpoint ||
          existing.authMode !== request.authMode ||
          (existing.headerName ?? undefined) !== request.headerName ||
          request.headerValue !== undefined;
        existing.name = request.name;
        existing.endpoint = request.endpoint;
        existing.authMode = request.authMode;
        existing.enabled = request.enabled;
        if (request.headerName) existing.headerName = request.headerName;
        if (identityChanged) {
          // A different endpoint, mechanism, or credential is a different
          // identity: revoke grants, cancel calls, and drop live clients.
          for (const grants of Object.values(next.grants)) delete grants[request.serverId];
          existing.enabled = false;
          existing.configGeneration += 1;
          delete existing.snapshot;
          delete existing.lastConnection;
          this.cancelServer(request.serverId);
          await this.closeServerClients(request.serverId);
        }
        if (request.authMode === "none") {
          existing.headerName = undefined;
          await this.secrets.delete(request.serverId).catch(() => undefined);
        } else if (request.headerValue !== undefined && request.headerName) {
          await this.assertSecureStorage();
          await this.secrets.setHeader(request.serverId, request.headerName, request.headerValue);
        }
      } else {
        const serverId = randomUUID();
        if (request.authMode === "header") {
          await this.assertSecureStorage();
          await this.secrets.setHeader(serverId, request.headerName!, request.headerValue!);
        }
        next.servers[serverId] = {
          serverId,
          name: request.name,
          endpoint: request.endpoint,
          authMode: request.authMode,
          enabled: request.enabled,
          configGeneration: 1,
          ...(request.headerName ? { headerName: request.headerName } : {}),
        };
      }
      await this.commit(next);
      return this.publishAndView();
    });
  }

  remove(value: unknown): Promise<McpSettingsView> {
    const { serverId } = parseMcpServerRequest(value);
    return this.enqueue(async () => {
      if (!this.state.servers[serverId])
        throw new WispBackendError("not_found", "This MCP connection no longer exists.");
      // Deny first so in-flight calls fail their recheck, then tear down.
      const next = structuredClone(this.state);
      delete next.servers[serverId];
      for (const grants of Object.values(next.grants)) delete grants[serverId];
      await this.commit(next);
      this.cancelServer(serverId);
      await this.closeServerClients(serverId);
      await this.secrets.delete(serverId).catch(() => undefined);
      unregisterDynamicToolMetadata(serverId);
      return this.publishAndView();
    });
  }

  /** Initializes and discovers capabilities without invoking any tool or granting access. */
  async testConnection(value: unknown): Promise<McpConnectionResult> {
    const request = parseTestMcpConnection(value);
    this.assertLive();
    const controller = new AbortController();
    this.running.set(controller, { conversationId: "", sessionId: "", serverId: request.serverId ?? "" });
    let connection: McpConnection | null = null;
    let provider: McpOAuthProvider | null = null;
    try {
      const auth = request.serverId
        ? await this.draftAuth(this.state.servers[request.serverId], request)
        : await this.draftAuth(undefined, request);
      if (auth.mode === "oauth" && auth.provider instanceof McpOAuthProvider) provider = auth.provider;
      connection = this.createConnection();
      const outcome = await connection.connect(request.endpoint, auth, { signal: controller.signal });
      if (outcome === "needs_sign_in") {
        return { message: "The server requires sign-in. Save the connection and use Sign in." };
      }
      const tools = await connection.listTools(controller.signal);
      return { message: `Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"} available.` };
    } catch (error) {
      throw safeMcpError(error, controller.signal);
    } finally {
      this.running.delete(controller);
      await connection?.close();
      provider?.dispose();
    }
  }

  /** Re-discovers the reviewed tool set for a saved server. */
  async refreshTools(value: unknown): Promise<McpSettingsView> {
    const { serverId } = parseMcpServerRequest(value);
    return this.enqueue(async () => {
      const server = this.state.servers[serverId];
      if (!server) throw new WispBackendError("not_found", "This MCP connection no longer exists.");
      const controller = new AbortController();
      this.running.set(controller, { conversationId: "", sessionId: "", serverId });
      let connection: McpConnection | null = null;
      let provider: McpOAuthProvider | null = null;
      try {
        const auth = await this.serverAuth(server);
        if (auth.mode === "oauth" && auth.provider instanceof McpOAuthProvider) provider = auth.provider;
        connection = this.createConnection();
        const outcome = await connection.connect(server.endpoint, auth, { signal: controller.signal });
        if (outcome === "needs_sign_in") {
          await this.noteConnection(server, "unavailable", "Sign in to this connection.");
          throw new WispBackendError("configuration_required", "Sign in to this connection before refreshing tools.");
        }
        const tools = await connection.listTools(controller.signal);
        const snapshot = this.buildSnapshot(tools, serverId);
        server.snapshot = { discoveredAt: new Date().toISOString(), tools: snapshot };
        server.lastConnection = { state: "connected", at: new Date().toISOString() };
        await this.commit(this.state);
        this.registerSnapshotMetadata();
        // A changed tool set replaces the reviewed definitions for granted Wisps.
        await this.closeServerClients(serverId);
      } catch (error) {
        if (!(error instanceof WispBackendError) || error.code !== "configuration_required") {
          await this.noteConnection(server, "unavailable");
        }
        throw safeMcpError(error, controller.signal);
      } finally {
        this.running.delete(controller);
        await connection?.close();
        provider?.dispose();
      }
      return this.publishAndView();
    });
  }

  /**
   * Runs the interactive OAuth sign-in flow, then discovers tools. The browser
   * wait happens outside the mutation queue — it can take minutes of human
   * time, and holding the queue would block saves, removals, and grants. Only
   * the state commit re-enters the queue, re-checking that the connection was
   * not removed or reconfigured while sign-in was in flight.
   */
  async startSignIn(value: unknown): Promise<McpSettingsView> {
    const { serverId } = parseMcpServerRequest(value);
    this.assertLive();
    const server = this.state.servers[serverId];
    if (!server) throw new WispBackendError("not_found", "This MCP connection no longer exists.");
    if (server.authMode !== "oauth") {
      throw new WispBackendError("invalid_request", "This connection does not use sign-in.");
    }
    if (this.activeSignIns.has(serverId)) {
      throw new WispBackendError("invalid_request", "A sign-in for this connection is already in progress.");
    }
    const endpoint = server.endpoint;
    const generation = server.configGeneration;
    const provider = this.createOAuthProvider(serverId);
    const controller = new AbortController();
    const signIn: ActiveSignIn = { controller, provider, cancelledByUser: false };
    // Registered like any other server operation, so removing the connection,
    // changing its identity, or shutting down aborts the sign-in too. An abort
    // stops the provider: a pending browser wait ends, a browser that has not
    // opened yet never does, and nothing more is written to the secret store.
    controller.signal.addEventListener("abort", () => provider.cancelSignIn(), { once: true });
    this.running.set(controller, { conversationId: "", sessionId: "", serverId });
    this.activeSignIns.set(serverId, signIn);
    let connection: McpConnection | null = null;
    try {
      // Every window learns a sign-in is waiting and can offer to cancel it.
      await this.publishAndView();
      await provider.loadPersistedTokens();
      await provider.loadPersistedClientInformation();
      await provider.ensureCallbackServer();
      controller.signal.throwIfAborted();
      connection = this.createConnection();
      // The signal is not passed on: the provider already refuses the redirect
      // and ends the browser wait on abort, and the reconnect that follows a
      // completed exchange must not be cut short after credentials were stored.
      const outcome = await connection.connect(
        endpoint,
        { mode: "oauth", provider },
        {
          allowInteractiveSignIn: true,
        },
      );
      if (outcome === "needs_sign_in") {
        this.signInTarget(serverId, generation);
        throw new WispBackendError("configuration_required", "Sign-in did not complete. Try again.");
      }
      // The exchange has completed, so a cancel arriving from here on is too
      // late to undo; removal and identity changes are re-checked at commit.
      const tools = await connection.listTools();
      await connection.close();
      connection = null;
      await this.enqueue(async () => {
        let current: McpServerRecord;
        try {
          current = this.signInTarget(serverId, generation);
        } catch (error) {
          // The exchange already stored credentials for a connection that is
          // now gone or has a different identity; they must not outlive it.
          await this.discardSignInCredentials(serverId);
          throw error;
        }
        current.snapshot = { discoveredAt: new Date().toISOString(), tools: this.buildSnapshot(tools, serverId) };
        current.lastConnection = { state: "connected", at: new Date().toISOString() };
        await this.commit(this.state);
        this.registerSnapshotMetadata();
      });
    } catch (error) {
      throw await this.signInFailure(error, signIn, serverId, generation);
    } finally {
      this.running.delete(controller);
      this.activeSignIns.delete(serverId);
      provider.dispose();
      await connection?.close();
      // However the sign-in ended, no window should keep showing it as waiting.
      await this.publishAndView().catch(() => undefined);
    }
    return this.getView();
  }

  /**
   * Cancels an in-progress interactive sign-in. Never touches the mutation
   * queue: it must stay responsive while a sign-in occupies the browser wait.
   */
  async cancelSignIn(value: unknown): Promise<McpSettingsView> {
    const { serverId } = parseMcpServerRequest(value);
    const signIn = this.activeSignIns.get(serverId);
    if (!signIn) {
      throw new WispBackendError("not_found", "No sign-in is in progress for this connection.");
    }
    signIn.cancelledByUser = true;
    signIn.controller.abort();
    return this.getView();
  }

  getAccess(value: unknown): WispMcpAccessView {
    const { conversationId } = parseMcpConversation(value);
    const sessionId = this.options.resolveWisp(conversationId);
    return {
      conversationId,
      revision: this.accessRevision(sessionId),
      grants: Object.values(this.state.servers)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((server) => ({ serverId: server.serverId, access: this.access(sessionId, server.serverId) })),
    };
  }

  saveAccess(value: unknown): Promise<WispMcpAccessView> {
    const request = parseSaveWispMcpAccess(value);
    return this.enqueue(async () => {
      const sessionId = this.options.resolveWisp(request.conversationId);
      this.assertAccessRevision(request.conversationId, sessionId, request.revision);
      const grants: Record<string, McpAccess> = Object.fromEntries(
        request.grants.map(({ serverId, access }) => [serverId, access]),
      );
      const increases = request.grants.filter(({ serverId, access }) => this.access(sessionId, serverId) !== access);
      for (const { serverId } of increases) {
        if (grants[serverId] !== "use_with_approval") continue;
        const server = this.state.servers[serverId];
        if (!server || !server.enabled) {
          throw new WispBackendError("configuration_required", "Enable the connection before granting access.");
        }
        if (server.authMode === "oauth" && !(await this.secrets.hasOAuthTokens(serverId))) {
          throw new WispBackendError("configuration_required", "Sign in to the connection before granting access.");
        }
      }
      this.assertAccessRevision(request.conversationId, sessionId, request.revision);
      const changedServers = Object.keys(this.state.servers).filter(
        (serverId) => this.access(sessionId, serverId) !== (grants[serverId] ?? "none"),
      );
      const next = structuredClone(this.state);
      next.grants[sessionId] = grants;
      await this.commit(next);
      for (const [controller, running] of this.running) {
        if (running.sessionId === sessionId && changedServers.includes(running.serverId)) controller.abort();
      }
      return this.getAccess({ conversationId: request.conversationId });
    });
  }

  /** Trusted snapshot for the Pi session; only granted, enabled servers appear. */
  async getSnapshot(conversationId: string): Promise<IntegrationToolSnapshot> {
    this.assertLive();
    const sessionId = this.options.resolveWisp(conversationId);
    const definitions: ToolDefinition[] = [];
    const metadata: SnapshotToolMetadata[] = [];
    const activeNames: string[] = [];
    const fingerprints: string[] = [];
    for (const server of Object.values(this.state.servers)) {
      if (!server.enabled || this.access(sessionId, server.serverId) === "none" || !server.snapshot) continue;
      fingerprints.push(
        server.serverId,
        String(server.configGeneration),
        ...server.snapshot.tools.map(({ fingerprint }) => fingerprint),
      );
      for (const tool of server.snapshot.tools) {
        definitions.push(this.wrapTool(conversationId, sessionId, server.serverId, server.name, tool));
        metadata.push({
          name: tool.alias,
          label: tool.label,
          activityLabel: `Calling ${tool.label}…`,
          category: "integration_call",
          mcpServerId: server.serverId,
          sourceName: tool.name,
        });
        activeNames.push(tool.alias);
      }
    }
    return {
      definitions,
      metadata,
      activeNames,
      revision: createHash("sha256")
        .update(JSON.stringify([sessionId, fingerprints]))
        .digest("hex"),
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.running.keys()) controller.abort();
    for (const { provider } of this.activeSignIns.values()) provider.dispose();
    for (const [key, entry] of this.pool) {
      entry.provider?.dispose();
      void entry.connection.close();
      this.pool.delete(key);
    }
  }

  private wrapTool(
    conversationId: string,
    sessionId: string,
    serverId: string,
    serverName: string,
    tool: McpToolRecord,
  ): ToolDefinition {
    return {
      name: tool.alias,
      label: tool.label,
      description: tool.description,
      parameters: toolInputSchema(tool.inputSchema),
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => ({
        content: [
          {
            type: "text",
            text: await this.executeTool(
              conversationId,
              sessionId,
              serverId,
              serverName,
              tool,
              toolCallId,
              params,
              signal,
            ),
          },
        ],
        details: {},
      }),
    } as ToolDefinition;
  }

  /** Authorization and dispatch path: check, approve, recheck, then call once. */
  private async executeTool(
    conversationId: string,
    sessionId: string,
    serverId: string,
    serverName: string,
    tool: McpToolRecord,
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertLive();
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.running.set(controller, { conversationId, sessionId, serverId });
    let dispatched = false;
    // The reviewed definition, captured before the approval wait.
    const reviewedGeneration = this.state.servers[serverId]?.configGeneration;
    const reviewedFingerprint = tool.fingerprint;
    try {
      combinedSignal.throwIfAborted();
      this.assertToolAccess(conversationId, sessionId, serverId);
      const args = validateToolArguments(tool, structuredClone(input));
      // Host-generated labels and the immutable snapshot define what is approved.
      await this.options.authorizationBroker.authorize(
        {
          conversationId,
          toolCallId,
          toolName: tool.alias,
          category: "integration_call",
          scope: { kind: "integration", value: serverName },
          summary: `${tool.label} — ${summarizeArguments(args)}`,
        },
        combinedSignal,
      );
      combinedSignal.throwIfAborted();
      // Recheck after the approval wait: grants and enablement may have
      // changed while the user was reviewing.
      this.assertToolAccess(conversationId, sessionId, serverId);
      // A tool that was replaced, changed, or removed while the approval was
      // pending must never receive the approved dispatch.
      this.assertToolUnchanged(serverId, reviewedGeneration, reviewedFingerprint);
      const connection = await this.pooledConnection(sessionId, serverId);
      dispatched = true;
      const result = await connection.callTool(tool.name, args, { signal: combinedSignal });
      const converted = convertResult(result);
      combinedSignal.throwIfAborted();
      await this.noteConnection(this.state.servers[serverId], "connected");
      return converted;
    } catch (error) {
      if (dispatched && combinedSignal.aborted && !(error instanceof WispBackendError)) {
        throw new WispBackendError(
          "aborted",
          "The MCP tool call was interrupted; the change may already have been applied.",
        );
      }
      if (error instanceof WispBackendError && error.code === "internal_error" && !dispatched) {
        await this.noteConnection(this.state.servers[serverId], "unavailable").catch(() => undefined);
      }
      throw safeMcpError(error, combinedSignal);
    } finally {
      this.running.delete(controller);
    }
  }

  private async pooledConnection(sessionId: string, serverId: string): Promise<McpConnection> {
    const server = this.state.servers[serverId];
    if (!server) throw new WispBackendError("tool_blocked", "This MCP connection was removed.");
    const key = `${sessionId}:${serverId}`;
    const existing = this.pool.get(key);
    if (existing) {
      if (existing.generation !== server.configGeneration) {
        await this.closePoolEntry(key, existing);
      } else if (existing.connection.connectionStatus === "connected") {
        return existing.connection;
      } else if (existing.connection.connectionStatus === "needs_sign_in") {
        throw new WispBackendError("configuration_required", "Sign in to this connection before use.");
      }
    }
    const auth = await this.serverAuth(server);
    const connection = this.createConnection();
    const outcome = await connection.connect(server.endpoint, auth);
    if (outcome === "needs_sign_in") {
      await connection.close();
      throw new WispBackendError("configuration_required", "Sign in to this connection before use.");
    }
    this.pool.set(key, {
      connection,
      generation: server.configGeneration,
      ...(auth.mode === "oauth" && auth.provider instanceof McpOAuthProvider ? { provider: auth.provider } : {}),
    });
    return connection;
  }

  private async serverAuth(server: McpServerRecord): Promise<McpConnectionAuth> {
    if (server.authMode === "none") return { mode: "none" };
    if (server.authMode === "header") {
      const secret = await this.secrets.read(server.serverId);
      if (secret?.type !== "header") {
        throw new WispBackendError("configuration_required", "This connection has no saved header value.");
      }
      return { mode: "header", headerName: server.headerName ?? secret.headerName, headerValue: secret.headerValue };
    }
    const provider = this.createOAuthProvider(server.serverId);
    await provider.loadPersistedTokens();
    await provider.loadPersistedClientInformation();
    // The SDK reads clientMetadata (which includes the callback redirect URI)
    // during discovery/registration, before any redirect happens.
    await provider.ensureCallbackServer();
    return { mode: "oauth", provider };
  }

  private async draftAuth(
    server: McpServerRecord | undefined,
    request: { authMode: McpAuthMode; headerName?: string; headerValue?: string },
  ): Promise<McpConnectionAuth> {
    if (request.authMode === "none") return { mode: "none" };
    if (request.authMode === "header") {
      if (request.headerValue !== undefined && request.headerName) {
        return { mode: "header", headerName: request.headerName, headerValue: request.headerValue };
      }
      const secret = server ? await this.secrets.read(server.serverId) : undefined;
      if (secret?.type === "header") {
        return {
          mode: "header",
          headerName: request.headerName ?? server?.headerName ?? secret.headerName,
          headerValue: secret.headerValue,
        };
      }
      throw new WispBackendError("configuration_required", "Enter a header value to test this connection.");
    }
    if (!server) throw new WispBackendError("invalid_request", "Save the connection before testing sign-in.");
    const provider = this.createOAuthProvider(server.serverId);
    await provider.loadPersistedTokens();
    await provider.loadPersistedClientInformation();
    // The SDK reads clientMetadata (which includes the callback redirect URI)
    // during discovery/registration, before any redirect happens.
    await provider.ensureCallbackServer();
    return { mode: "oauth", provider };
  }

  private async noteConnection(
    server: McpServerRecord | undefined,
    state: "connected" | "unavailable",
    message?: string,
  ): Promise<void> {
    if (!server) return;
    // Health state is kept in memory only: persisting it would rotate the
    // revision on every call and invalidate open access forms everywhere.
    server.lastConnection = {
      state,
      at: new Date().toISOString(),
      ...(state === "unavailable" ? { message: message ?? "The connection failed." } : {}),
    };
    this.options.onSettingsChanged?.(await this.getView());
  }

  private connectionState(server: McpServerRecord, signedIn: boolean): McpConnectionState {
    if (server.authMode === "oauth" && !signedIn) return "needs_sign_in";
    if (server.lastConnection?.state === "unavailable") return "unavailable";
    if (server.lastConnection?.state === "connected") return "connected";
    return "configured";
  }

  private buildSnapshot(tools: ReadonlyArray<McpSdkTool>, serverId: string): McpToolRecord[] {
    const records: McpToolRecord[] = [];
    const seenNames = new Set<string>();
    const usedAliases = new Set<string>();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)) continue;
      if (seenNames.has(tool.name)) continue;
      const schema = boundedSchema(tool.inputSchema);
      if (schema === undefined) continue;
      seenNames.add(tool.name);
      // Distinct names like "search.users" and "search_users" normalize onto
      // the same slug; keep both with a stable, name-derived suffix.
      let alias = mcpToolAlias(serverId, tool.name);
      if (usedAliases.has(alias)) {
        alias = disambiguateMcpAlias(alias, tool.name);
        if (usedAliases.has(alias)) continue;
      }
      usedAliases.add(alias);
      const description = boundedText(tool.description ?? "", MAX_TOOL_DESCRIPTION_CHARACTERS);
      records.push({
        name: tool.name,
        alias,
        label: boundedText(tool.name, 60),
        description,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([tool.name, description, schema]))
          .digest("hex"),
        inputSchema: schema,
      });
      if (records.length >= MAX_TOOL_SNAPSHOT_TOOLS) break;
    }
    if (!records.length) throw new WispBackendError("invalid_configuration", "This server exposes no usable tools.");
    return records;
  }

  private registerSnapshotMetadata(): void {
    for (const server of Object.values(this.state.servers)) {
      if (!server.snapshot) continue;
      registerDynamicToolMetadata(
        server.snapshot.tools.map((tool) => ({
          name: tool.alias,
          label: tool.label,
          activityLabel: `Calling ${tool.label}…`,
          mcpServerId: server.serverId,
          sourceName: tool.name,
        })),
      );
    }
  }

  private assertToolAccess(conversationId: string, sessionId: string, serverId: string): void {
    if (this.options.resolveWisp(conversationId) !== sessionId) {
      throw new WispBackendError("tool_blocked", "This Wisp no longer exists.");
    }
    const server = this.state.servers[serverId];
    if (!server || !server.enabled || this.access(sessionId, serverId) === "none") {
      throw new WispBackendError("tool_blocked", "This Wisp does not have access to this connection.");
    }
  }

  private assertToolUnchanged(serverId: string, generation: number | undefined, fingerprint: string): void {
    const server = this.state.servers[serverId];
    if (
      !server ||
      server.configGeneration !== generation ||
      !server.snapshot?.tools.some((tool) => tool.fingerprint === fingerprint)
    ) {
      throw new WispBackendError("tool_blocked", "This tool changed before it could run. Ask the Wisp to try again.");
    }
  }

  private access(sessionId: string, serverId: string): McpAccess {
    return this.state.grants[sessionId]?.[serverId] ?? "none";
  }

  /**
   * Revision scoped to this Wisp plus the servers it is granted: unrelated
   * servers or other Wisps' grants never invalidate this Wisp's form.
   */
  private accessRevision(sessionId: string): string {
    const grants = this.state.grants[sessionId] ?? {};
    const entries = Object.entries(grants)
      .filter(([, access]) => access !== "none")
      .map(([serverId]) => {
        const server = this.state.servers[serverId];
        return [
          serverId,
          server?.enabled ?? null,
          server?.configGeneration ?? null,
          server?.authMode ?? null,
          (server?.snapshot?.tools ?? []).map(({ fingerprint }) => fingerprint).sort(),
        ];
      })
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    // Only this Wisp's grants and its granted servers' configuration define
    // the form: unrelated servers or other Wisps must not invalidate it.
    return createHash("sha256")
      .update(JSON.stringify([sessionId, entries]))
      .digest("hex");
  }

  private assertAccessRevision(conversationId: string, sessionId: string, revision: string): void {
    if (this.options.resolveWisp(conversationId) !== sessionId || revision !== this.accessRevision(sessionId)) {
      throw new WispBackendError("invalid_request", "MCP access has changed. Reload access settings before saving.");
    }
  }

  /** A cancelled sign-in is no longer waiting, even while its flow unwinds. */
  private isSignInPending(serverId: string): boolean {
    const signIn = this.activeSignIns.get(serverId);
    return signIn !== undefined && !signIn.controller.signal.aborted;
  }

  /** The connection a sign-in started for, unless it was removed or re-identified since. */
  private signInTarget(serverId: string, generation: number): McpServerRecord {
    const current = this.state.servers[serverId];
    if (!current) throw new WispBackendError("not_found", "This MCP connection no longer exists.");
    if (current.configGeneration !== generation) {
      throw new WispBackendError(
        "invalid_request",
        "This connection changed during sign-in. Review it and sign in again.",
      );
    }
    return current;
  }

  private async signInFailure(
    error: unknown,
    signIn: ActiveSignIn,
    serverId: string,
    generation: number,
  ): Promise<WispBackendError> {
    if (signIn.cancelledByUser) return new WispBackendError("aborted", "The sign-in was cancelled.");
    if (signIn.controller.signal.aborted) {
      // Aborted by a removal, an identity change, or shutdown. Let that
      // mutation land first so the failure names it, not a bare cancellation.
      const reason = await this.enqueue(async () => this.signInTarget(serverId, generation)).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      if (reason instanceof WispBackendError) return reason;
    }
    return safeMcpError(error, signIn.controller.signal);
  }

  private async discardSignInCredentials(serverId: string): Promise<void> {
    const discard = this.state.servers[serverId]
      ? this.secrets.clearOAuthTokens(serverId)
      : this.secrets.delete(serverId);
    await discard.catch(() => undefined);
  }

  private cancelServer(serverId: string): void {
    for (const [controller, running] of this.running) {
      if (running.serverId === serverId) controller.abort();
    }
  }

  private async closeServerClients(serverId: string): Promise<void> {
    for (const [key, entry] of this.pool) {
      if (key.endsWith(`:${serverId}`)) {
        await this.closePoolEntry(key, entry);
      }
    }
  }

  private async closePoolEntry(key: string, entry: PoolEntry): Promise<void> {
    this.pool.delete(key);
    entry.provider?.dispose();
    await entry.connection.close();
  }

  private createConnection(): McpConnection {
    if (this.options.createConnection) return this.options.createConnection({ fetch: undefined });
    return new McpConnection({
      onClosed: () => {
        void this.publishAndView();
      },
    });
  }

  private createOAuthProvider(serverId: string): McpOAuthProvider {
    if (this.options.createOAuthProvider) return this.options.createOAuthProvider(serverId);
    return new McpOAuthProvider({ serverId, secrets: this.secrets, openExternal: this.options.openExternal });
  }

  private async publishAndView(): Promise<McpSettingsView> {
    const view = await this.getView();
    this.options.onSettingsChanged?.(view);
    return view;
  }

  private async commit(next: McpState): Promise<void> {
    const committed = { ...next, revision: randomUUID() };
    const json = JSON.stringify(committed);
    if (Buffer.byteLength(json) > 2_000_000) throw invalidMcpRequest();
    await writeFileAtomically(this.filePath, `${json}\n`);
    this.state = committed;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(() => {
      this.assertLive();
      return operation();
    });
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertLive(): void {
    if (this.disposed) throw new WispBackendError("disposed", "The MCP service has stopped.");
  }

  private async assertSecureStorage(): Promise<void> {
    if (!this.secrets.isSecureStorageAvailable()) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Secure credential storage is unavailable on this device.",
      );
    }
  }
}

function defaultState(): McpState {
  return { schemaVersion: 1, revision: randomUUID(), servers: {}, grants: {} };
}

function normalizeState(value: unknown): McpState {
  const raw = mcpRecord(value, ["schemaVersion", "revision", "servers", "grants"]);
  if (raw.schemaVersion !== 1) throw invalidMcpRequest();
  const normalized = defaultState();
  if (typeof raw.revision === "string" && /^[a-f0-9-]{36}$/.test(raw.revision)) normalized.revision = raw.revision;
  const servers = mcpRecord(raw.servers);
  for (const [serverId, entry] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(serverId)) throw invalidMcpRequest();
    const record = mcpRecord(entry, [
      "serverId",
      "name",
      "endpoint",
      "authMode",
      "enabled",
      "configGeneration",
      "headerName",
      "snapshot",
      "lastConnection",
    ]);
    if (record.serverId !== serverId) throw invalidMcpRequest();
    const snapshotRaw = record.snapshot;
    let snapshot: McpServerRecord["snapshot"];
    if (snapshotRaw && typeof snapshotRaw === "object" && !Array.isArray(snapshotRaw)) {
      const snapshotRecord = mcpRecord(snapshotRaw, ["discoveredAt", "tools"]);
      if (typeof snapshotRecord.discoveredAt !== "string" || !Array.isArray(snapshotRecord.tools))
        throw invalidMcpRequest();
      const tools: McpToolRecord[] = [];
      for (const tool of snapshotRecord.tools) {
        const toolRecord = mcpRecord(tool, ["name", "alias", "label", "description", "fingerprint", "inputSchema"]);
        if (
          typeof toolRecord.name !== "string" ||
          typeof toolRecord.alias !== "string" ||
          typeof toolRecord.label !== "string" ||
          typeof toolRecord.description !== "string" ||
          typeof toolRecord.fingerprint !== "string"
        )
          throw invalidMcpRequest();
        tools.push({
          name: toolRecord.name,
          alias: toolRecord.alias,
          label: toolRecord.label,
          description: toolRecord.description,
          fingerprint: toolRecord.fingerprint,
          inputSchema: toolRecord.inputSchema,
        });
      }
      snapshot = { discoveredAt: snapshotRecord.discoveredAt, tools };
    }
    let lastConnection: McpServerRecord["lastConnection"];
    if (record.lastConnection && typeof record.lastConnection === "object") {
      const connectionRecord = mcpRecord(record.lastConnection, ["state", "at", "message"]);
      if (
        (connectionRecord.state !== "connected" && connectionRecord.state !== "unavailable") ||
        typeof connectionRecord.at !== "string"
      )
        throw invalidMcpRequest();
      lastConnection = {
        state: connectionRecord.state,
        at: connectionRecord.at,
        ...(typeof connectionRecord.message === "string" ? { message: connectionRecord.message } : {}),
      };
    }
    normalized.servers[serverId] = {
      serverId,
      name: typeof record.name === "string" ? record.name : serverId,
      endpoint: typeof record.endpoint === "string" ? record.endpoint : "",
      authMode: record.authMode === "oauth" || record.authMode === "header" ? record.authMode : "none",
      enabled: record.enabled === true,
      configGeneration: typeof record.configGeneration === "number" ? record.configGeneration : 1,
      ...(typeof record.headerName === "string" ? { headerName: record.headerName } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(lastConnection ? { lastConnection } : {}),
    };
  }
  const grants = mcpRecord(raw.grants);
  for (const [sessionId, value] of Object.entries(grants)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sessionId)) throw invalidMcpRequest();
    const sessionGrants = mcpRecord(value);
    const normalizedGrants: Record<string, McpAccess> = {};
    for (const [serverId, access] of Object.entries(sessionGrants)) {
      if (access !== "none" && access !== "use_with_approval") throw invalidMcpRequest();
      normalizedGrants[serverId] = access;
    }
    normalized.grants[sessionId] = normalizedGrants;
  }
  return normalized;
}

function toolInputSchema(schema: unknown): Record<string, unknown> {
  if (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  ) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Minimal validation against the reviewed schema; dispatch uses the original name. */
function validateToolArguments(tool: McpToolRecord, args: unknown): Record<string, unknown> {
  const json = JSON.stringify(args ?? {});
  if (json === undefined || Buffer.byteLength(json) > MAX_ARGUMENT_JSON_BYTES) {
    throw new WispBackendError("invalid_request", "The tool arguments are too large.");
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new WispBackendError("invalid_request", "The tool arguments must be an object.");
  }
  const schema = tool.inputSchema as { required?: unknown } | undefined;
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]) : [];
  const record = args as Record<string, unknown>;
  for (const key of required) {
    if (typeof key === "string" && !(key in record)) {
      throw new WispBackendError("invalid_request", `The tool arguments are missing "${key}".`);
    }
  }
  return record;
}

function summarizeArguments(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 6) {
      parts.push("…");
      break;
    }
    const display = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? truncate(value, MAX_SUMMARY_ARGUMENT_CHARACTERS)
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : Array.isArray(value) || (value && typeof value === "object")
            ? "[structured value]"
            : "null";
    parts.push(`${key}: ${display}`);
  }
  return parts.join(", ") || "no arguments";
}

function convertResult(result: unknown): string {
  const converted = convertMcpToolResult(result);
  if (converted.isError) {
    // An MCP isError result must surface as a failed tool call, never as
    // successful activity in Pi.
    throw new WispBackendError("internal_error", boundedErrorText(converted.text), false);
  }
  return converted.text;
}

function boundedSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(schema);
  } catch {
    return undefined;
  }
  if (json === undefined || Buffer.byteLength(json) > MAX_TOOL_SCHEMA_JSON_BYTES) return undefined;
  return schema;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maxLength);
}

function boundedErrorText(value: string): string {
  return truncate(value, 500) || "The MCP tool reported an error.";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function safeMcpError(error: unknown, signal?: AbortSignal): WispBackendError {
  if (error instanceof WispBackendError) return error;
  if (signal?.aborted) return new WispBackendError("aborted", "The MCP request was cancelled.");
  return new WispBackendError("internal_error", "The MCP server could not complete the request.", true);
}
