import { readFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import {
  PLUGIN_CATALOG,
  PLUGIN_IDS,
  WEB_CAPABILITIES,
  type PluginAccess,
  type PluginId,
  type PluginSettingsView,
  type WebCapability,
  type WebProviders,
  type WispPluginAccessView,
  type PluginConnectionResult,
} from "../shared/plugins.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import { EncryptedCredentialStore, type EncryptionService } from "./encrypted-credential-store.js";
import type { IntegrationToolSource, IntegrationToolSnapshot } from "./integration-tool-source.js";
import { snapshotRevision } from "./integration-tool-source.js";
import { PLUGIN_ADAPTERS } from "./plugin-adapters.js";
import type { PluginAdapter, PluginToolSource, PluginToolSpec } from "./plugin-types.js";
import { getToolMetadata } from "../shared/tool-catalog.js";
import {
  invalidPluginRequest,
  parseGrants,
  parsePluginConversation,
  parsePluginId,
  parsePluginRequest,
  parseSavePluginDefaults,
  parseSavePluginSettings,
  parseSaveWispPluginAccess,
  parseTestPluginConnection,
  parseWebProviders,
  pluginRecord,
} from "./plugin-validation.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { isSharedWebTool } from "./web-tools.js";

interface PluginToolBinding {
  pluginId: PluginId;
  tool: PluginToolSpec;
}

type AccessMap = Partial<Record<PluginId, PluginAccess>>;
interface PluginState {
  schemaVersion: 1;
  revision: string;
  enabled: Record<PluginId, boolean>;
  // Application session IDs prevent a deleted/recreated conversation from inheriting access.
  grants: Record<string, AccessMap>;
  /** Explicit provider per web capability. Sessions without an entry use catalog order among their grants. */
  webProviders: Record<string, WebProviders>;
  /** Provider preselected when a Wisp turns a capability on. */
  defaultProviders: Partial<Record<WebCapability, PluginId>>;
}

export interface PluginServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
  resolveWisp: (conversationId: string) => string;
  adapters?: ReadonlyArray<PluginAdapter>;
}

function defaultState(): PluginState {
  return {
    schemaVersion: 1,
    revision: randomUUID(),
    enabled: { "web-search": false, linear: false, firecrawl: false, tavily: false, exa: false },
    grants: {},
    webProviders: {},
    defaultProviders: {},
  };
}

export class PluginService implements PluginToolSource, IntegrationToolSource {
  private state = defaultState();
  private readonly filePath: string;
  private readonly credentials: EncryptedCredentialStore;
  private readonly adapters: ReadonlyArray<PluginAdapter>;
  private mutation = Promise.resolve();
  private disposed = false;
  private readonly running = new Map<AbortController, { pluginId: PluginId; sessionId?: string }>();

  constructor(private readonly options: PluginServiceOptions) {
    this.filePath = path.join(options.dataDirectory, "plugins.json");
    this.credentials = new EncryptedCredentialStore(
      path.join(options.dataDirectory, "plugin-credentials.enc.json"),
      options.encryption,
    );
    this.adapters = options.adapters ?? PLUGIN_ADAPTERS;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(content) > 2_000_000) throw invalidPluginRequest();
      const raw = pluginRecord(JSON.parse(content), [
        "schemaVersion",
        "revision",
        "enabled",
        "grants",
        "webProviders",
        "defaultProviders",
      ]);
      if (raw.schemaVersion !== 1) throw invalidPluginRequest();
      if (
        raw.revision !== undefined &&
        (typeof raw.revision !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw.revision))
      )
        throw invalidPluginRequest();
      const enabled = pluginRecord(raw.enabled, PLUGIN_IDS);
      const grants = pluginRecord(raw.grants);
      const normalized = defaultState();
      // Older settings have no revision. A fresh token invalidates any old form.
      if (typeof raw.revision === "string") normalized.revision = raw.revision;
      for (const id of PLUGIN_IDS) {
        // Plugins added after the original schema start disabled in older settings.
        if (enabled[id] === undefined && id !== "web-search" && id !== "linear") continue;
        if (typeof enabled[id] !== "boolean") throw invalidPluginRequest();
        normalized.enabled[id] = enabled[id] === true;
      }
      for (const [sessionId, value] of Object.entries(grants)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sessionId)) throw invalidPluginRequest();
        const entries = parseGrants(
          Object.entries(pluginRecord(value, PLUGIN_IDS)).map(([pluginId, access]) => ({ pluginId, access })),
        );
        Object.defineProperty(normalized.grants, sessionId, {
          value: Object.fromEntries(entries.map(({ pluginId, access }) => [pluginId, access])),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      // Both fields are optional: settings saved before explicit provider choices fall back to catalog order.
      for (const [sessionId, value] of Object.entries(pluginRecord(raw.webProviders ?? {}))) {
        if (!Object.hasOwn(normalized.grants, sessionId)) throw invalidPluginRequest();
        Object.defineProperty(normalized.webProviders, sessionId, {
          value: parseWebProviders(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const defaults = parseWebProviders(raw.defaultProviders ?? {});
      for (const { id } of WEB_CAPABILITIES) if (defaults[id]) normalized.defaultProviders[id] = defaults[id];
      this.state = normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Recover with every plugin disabled and every Wisp denied.
      this.state = defaultState();
      await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    }
  }

  async getView(): Promise<PluginSettingsView> {
    let configured = new Set<string>();
    let credentialError: string | undefined;
    try {
      configured = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    } catch {
      credentialError =
        "Saved plugin credentials are unavailable. Plugin access is disabled until secure storage can be read again.";
    }
    const available = (pluginId: PluginId) => this.state.enabled[pluginId] && configured.has(pluginId);
    const defaultProviders = { search: null, read: null } as WebProviders;
    for (const { id: capability } of WEB_CAPABILITIES) {
      const chosen = this.state.defaultProviders[capability];
      defaultProviders[capability] =
        chosen && available(chosen)
          ? chosen
          : (PLUGIN_CATALOG.find(({ id, capabilities }) => capabilities.includes(capability) && available(id))?.id ??
            null);
    }
    return {
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      ...(credentialError ? { credentialError } : {}),
      plugins: PLUGIN_CATALOG.map((plugin) => ({
        ...plugin,
        enabled: this.state.enabled[plugin.id],
        configured: configured.has(plugin.id),
      })),
      defaultProviders,
    };
  }

  saveDefaults(value: unknown): Promise<PluginSettingsView> {
    const { defaultProviders } = parseSavePluginDefaults(value);
    return this.enqueue(async () => {
      const configured = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
      const next = structuredClone(this.state);
      next.defaultProviders = {};
      for (const { id: capability } of WEB_CAPABILITIES) {
        const pluginId = defaultProviders[capability];
        if (!pluginId) continue;
        if (!this.state.enabled[pluginId] || !configured.has(pluginId))
          throw new WispBackendError(
            "configuration_required",
            "Connect and enable the plugin before making it the default.",
          );
        next.defaultProviders[capability] = pluginId;
      }
      await this.commit(next);
      return this.getView();
    });
  }

  save(value: unknown): Promise<PluginSettingsView> {
    const request = parseSavePluginSettings(value);
    return this.enqueue(async () => {
      const { pluginId, apiKey, enabled } = request;
      const existing = enabled || apiKey ? await this.readKey(pluginId) : undefined;
      if (enabled && !apiKey && !existing)
        throw new WispBackendError("configuration_required", "Add an API key before enabling this plugin.");
      if (apiKey && apiKey !== existing) {
        if (!this.credentials.isSecureStorageAvailable())
          throw new WispBackendError(
            "secure_storage_unavailable",
            "Secure credential storage is unavailable on this device.",
          );
        // A different key may identify a different account. Revoke old grants before changing it.
        await this.commit(this.withoutPluginAccess(pluginId));
        this.cancelPlugin(pluginId);
        await this.credentials.setApiKey(pluginId, apiKey);
      }
      const next = structuredClone(this.state);
      const enabledChanged = next.enabled[pluginId] !== enabled;
      next.enabled[pluginId] = enabled;
      await this.commit(next);
      if (enabledChanged) this.cancelPlugin(pluginId);
      return this.getView();
    });
  }

  remove(value: unknown): Promise<PluginSettingsView> {
    const { pluginId } = parsePluginRequest(value);
    return this.enqueue(async () => {
      await this.commit(this.withoutPluginAccess(pluginId));
      this.cancelPlugin(pluginId);
      await this.credentials.delete(pluginId);
      return this.getView();
    });
  }

  async testConnection(value: unknown): Promise<PluginConnectionResult> {
    const request = parseTestPluginConnection(value);
    this.assertLive();
    const controller = new AbortController();
    this.running.set(controller, { pluginId: request.pluginId });
    try {
      const apiKey = request.apiKey ?? (await this.readKey(request.pluginId));
      if (!apiKey) throw new WispBackendError("configuration_required", "Add an API key to test this plugin.");
      controller.signal.throwIfAborted();
      return { message: await this.adapter(request.pluginId).testConnection(apiKey, controller.signal) };
    } catch (error) {
      throw safePluginError(error, controller.signal);
    } finally {
      this.running.delete(controller);
    }
  }

  getAccess(value: unknown): WispPluginAccessView {
    const { conversationId } = parsePluginConversation(value);
    const sessionId = this.options.resolveWisp(conversationId);
    const webProviders = { search: null, read: null } as WebProviders;
    for (const { id } of WEB_CAPABILITIES) webProviders[id] = this.webProvider(sessionId, id);
    return {
      conversationId,
      revision: this.accessRevision(sessionId),
      grants: PLUGIN_IDS.map((pluginId) => ({ pluginId, access: this.access(sessionId, pluginId) })),
      webProviders,
    };
  }

  saveAccess(value: unknown): Promise<WispPluginAccessView> {
    const request = parseSaveWispPluginAccess(value);
    return this.enqueue(async () => {
      const sessionId = this.options.resolveWisp(request.conversationId);
      this.assertAccessRevision(request.conversationId, sessionId, request.revision);
      const grants: AccessMap = Object.fromEntries(request.grants.map(({ pluginId, access }) => [pluginId, access]));
      const increases = request.grants.filter(
        ({ pluginId, access }) => accessRank(access) > accessRank(this.access(sessionId, pluginId)),
      );
      if (increases.length) {
        const configured = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
        if (increases.some(({ pluginId }) => !this.state.enabled[pluginId] || !configured.has(pluginId)))
          throw new WispBackendError(
            "configuration_required",
            "Configure and enable the plugin before granting access.",
          );
      }
      this.assertAccessRevision(request.conversationId, sessionId, request.revision);
      const changedPlugins = PLUGIN_IDS.filter(
        (pluginId) => this.access(sessionId, pluginId) !== (grants[pluginId] ?? "none"),
      );
      const next = structuredClone(this.state);
      Object.defineProperty(next.grants, sessionId, {
        value: grants,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (request.webProviders) {
        // A provider replaced for a capability stops its in-flight calls, like a revoked grant.
        for (const { id } of WEB_CAPABILITIES) {
          const previous = this.webProvider(sessionId, id);
          if (previous && previous !== request.webProviders[id]) changedPlugins.push(previous);
        }
        Object.defineProperty(next.webProviders, sessionId, {
          value: request.webProviders,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else delete next.webProviders[sessionId];
      await this.commit(next);
      for (const [controller, running] of this.running)
        if (running.sessionId === sessionId && changedPlugins.includes(running.pluginId)) controller.abort();
      return this.getAccess({ conversationId: request.conversationId });
    });
  }

  getTools(conversationId: string): ToolDefinition[] {
    const sessionId = this.options.resolveWisp(conversationId);
    const bindings = new Map<string, PluginToolBinding>();
    for (const adapter of this.adapters) {
      for (const tool of adapter.tools) {
        if (bindings.has(tool.name)) {
          if (!isSharedWebTool(tool.name)) throw new Error(`Plugin tool name collision: ${tool.name}`);
          continue;
        }
        bindings.set(tool.name, { pluginId: adapter.id, tool });
      }
    }
    return [...bindings.values()].map(
      ({ pluginId, tool }): ToolDefinition => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (toolCallId, params, signal) => {
          let binding = { pluginId, tool };
          if (isSharedWebTool(tool.name)) {
            signal?.throwIfAborted();
            this.assertLive();
            if (this.options.resolveWisp(conversationId) !== sessionId)
              throw new WispBackendError("tool_blocked", "This Wisp no longer has access to the plugin.");
            const active = (await this.getActiveBindings(conversationId)).find(
              ({ tool: candidate }) => candidate.name === tool.name,
            );
            signal?.throwIfAborted();
            if (!active) throw new WispBackendError("tool_blocked", "No connected web plugin is granted to this Wisp.");
            binding = active;
          }
          return {
            content: [
              {
                type: "text",
                text: await this.execute(
                  conversationId,
                  sessionId,
                  binding.pluginId,
                  binding.tool,
                  toolCallId,
                  params,
                  signal,
                ),
              },
            ],
            details: {},
          };
        },
      }),
    );
  }

  /** Snapshot adapter: bundled definitions are static; only the active set varies. */
  async getSnapshot(conversationId: string): Promise<IntegrationToolSnapshot> {
    this.assertLive();
    const definitions = this.getTools(conversationId);
    const bindings = await this.getActiveBindings(conversationId);
    const activeNames = [...new Set(bindings.map(({ tool }) => tool.name))];
    return {
      definitions,
      metadata: definitions.flatMap(({ name }) => {
        const catalogMetadata = getToolMetadata(name);
        return catalogMetadata?.pluginId || catalogMetadata?.pluginIds
          ? [
              {
                name,
                label: catalogMetadata.label,
                activityLabel: catalogMetadata.activityLabel,
                category: catalogMetadata.category,
              },
            ]
          : [];
      }),
      activeNames,
      revision: snapshotRevision(bindings.map(({ pluginId, tool }) => `${pluginId}:${tool.name}`)),
    };
  }

  async getActiveToolNames(conversationId: string): Promise<string[]> {
    return [...new Set((await this.getActiveBindings(conversationId)).map(({ tool }) => tool.name))];
  }

  private async getActiveBindings(conversationId: string): Promise<PluginToolBinding[]> {
    this.assertLive();
    const sessionId = this.options.resolveWisp(conversationId);
    if (
      !this.adapters.some((adapter) => this.state.enabled[adapter.id] && this.access(sessionId, adapter.id) !== "none")
    )
      return [];
    let configured: Set<string>;
    try {
      configured = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    } catch {
      // Optional integrations must not prevent the Wisp's built-in tools from starting.
      configured = new Set();
    }
    this.assertLive();
    if (this.options.resolveWisp(conversationId) !== sessionId) return [];
    const usable = (pluginId: PluginId) =>
      this.state.enabled[pluginId] && configured.has(pluginId) && this.access(sessionId, pluginId) !== "none";
    // Each shared web tool is backed by exactly one provider: the Wisp's choice, or the
    // first usable granted provider in catalog order for settings saved before choices existed.
    const webTools = new Map<string, PluginId>();
    const explicit = this.explicitWebProviders(sessionId);
    for (const { id, toolName } of WEB_CAPABILITIES) {
      const provider = explicit
        ? explicit[id]
        : this.adapters.find((adapter) => usable(adapter.id) && adapter.tools.some(({ name }) => name === toolName))
            ?.id;
      if (provider && usable(provider)) webTools.set(toolName, provider);
    }
    return this.adapters.flatMap((adapter) => {
      if (!usable(adapter.id)) return [];
      const access = this.access(sessionId, adapter.id);
      return adapter.tools
        .filter((tool) => access === "write" || (access === "read" && tool.access === "read"))
        .filter((tool) => !isSharedWebTool(tool.name) || webTools.get(tool.name) === adapter.id)
        .map((tool) => ({ pluginId: adapter.id, tool }));
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.running.keys()) controller.abort();
  }

  private async execute(
    conversationId: string,
    sessionId: string,
    pluginId: PluginId,
    tool: PluginToolSpec,
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertLive();
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.running.set(controller, { pluginId, sessionId });
    let dispatched = false;
    try {
      combinedSignal.throwIfAborted();
      this.assertAccess(conversationId, sessionId, pluginId, tool.access);
      const params = structuredClone(input);
      if (tool.access === "write") {
        await this.options.authorizationBroker.authorize(
          {
            conversationId,
            toolCallId,
            toolName: tool.name,
            category: "external_write",
            scope: { kind: "integration", value: PLUGIN_CATALOG.find(({ id }) => id === pluginId)!.name },
            summary: tool.summarize(params),
          },
          combinedSignal,
        );
      }
      const apiKey = await this.readKey(pluginId);
      combinedSignal.throwIfAborted();
      this.assertAccess(conversationId, sessionId, pluginId, tool.access);
      if (!apiKey) throw new WispBackendError("configuration_required", "This plugin is not connected.");
      dispatched = true;
      const result = await tool.execute(apiKey, params, combinedSignal);
      combinedSignal.throwIfAborted();
      return Buffer.byteLength(result) <= 64_000
        ? result
        : `${Buffer.from(result).subarray(0, 63_900).toString("utf8")}\n[Result truncated]`;
    } catch (error) {
      if (!(error instanceof WispBackendError) && dispatched && tool.access === "write" && combinedSignal.aborted) {
        throw new WispBackendError(
          "aborted",
          "The plugin action was interrupted. Check Linear before repeating it; the change may already have been applied.",
        );
      }
      throw safePluginError(error, combinedSignal);
    } finally {
      this.running.delete(controller);
    }
  }

  private assertAccess(
    conversationId: string,
    sessionId: string,
    pluginId: PluginId,
    required: "read" | "write",
  ): void {
    if (this.options.resolveWisp(conversationId) !== sessionId)
      throw new WispBackendError("tool_blocked", "This Wisp no longer has access to the plugin.");
    const access = this.access(sessionId, pluginId);
    if (!this.state.enabled[pluginId] || access === "none" || (required === "write" && access !== "write"))
      throw new WispBackendError("tool_blocked", "This Wisp does not have access to this plugin action.");
  }

  private access(sessionId: string, pluginId: PluginId): PluginAccess {
    return Object.hasOwn(this.state.grants, sessionId) ? (this.state.grants[sessionId]?.[pluginId] ?? "none") : "none";
  }

  private explicitWebProviders(sessionId: string): WebProviders | undefined {
    return Object.hasOwn(this.state.webProviders, sessionId) ? this.state.webProviders[sessionId] : undefined;
  }

  /** Provider shown for a capability; legacy sessions report the first granted provider in catalog order. */
  private webProvider(sessionId: string, capability: WebCapability): PluginId | null {
    const explicit = this.explicitWebProviders(sessionId);
    if (explicit) return explicit[capability];
    const granted = PLUGIN_CATALOG.filter(
      ({ id, capabilities }) => capabilities.includes(capability) && this.access(sessionId, id) !== "none",
    );
    return (granted.find(({ id }) => this.state.enabled[id]) ?? granted[0])?.id ?? null;
  }

  private accessRevision(sessionId: string): string {
    return createHash("sha256")
      .update(JSON.stringify([this.state.revision, sessionId]))
      .digest("hex");
  }

  private assertAccessRevision(conversationId: string, sessionId: string, revision: string): void {
    if (this.options.resolveWisp(conversationId) !== sessionId || revision !== this.accessRevision(sessionId))
      throw new WispBackendError("invalid_request", "Plugin access has changed. Reload access settings before saving.");
  }

  private async readKey(pluginId: PluginId): Promise<string | undefined> {
    const credential = await this.credentials.read(pluginId);
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  private adapter(pluginId: PluginId): PluginAdapter {
    const adapter = this.adapters.find(({ id }) => id === parsePluginId(pluginId));
    if (!adapter) throw invalidPluginRequest();
    return adapter;
  }

  private withoutPluginAccess(pluginId: PluginId): PluginState {
    const next = structuredClone(this.state);
    next.enabled[pluginId] = false;
    for (const grants of Object.values(next.grants)) delete grants[pluginId];
    for (const providers of Object.values(next.webProviders))
      for (const { id } of WEB_CAPABILITIES) if (providers[id] === pluginId) providers[id] = null;
    for (const { id } of WEB_CAPABILITIES) if (next.defaultProviders[id] === pluginId) delete next.defaultProviders[id];
    return next;
  }

  private cancelPlugin(pluginId: PluginId): void {
    for (const [controller, running] of this.running) if (running.pluginId === pluginId) controller.abort();
  }

  private async commit(next: PluginState): Promise<void> {
    const committed = { ...next, revision: randomUUID() };
    const json = JSON.stringify(committed);
    if (Buffer.byteLength(json) > 2_000_000) throw invalidPluginRequest();
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
    if (this.disposed) throw new WispBackendError("disposed", "The plugin service has stopped.");
  }
}

function accessRank(access: PluginAccess): number {
  return access === "write" ? 2 : access === "read" ? 1 : 0;
}

function safePluginError(error: unknown, signal: AbortSignal): WispBackendError {
  if (error instanceof WispBackendError) return error;
  if (signal.aborted) return new WispBackendError("aborted", "The plugin action was cancelled.");
  return new WispBackendError("internal_error", "The plugin could not complete the request.", true);
}
