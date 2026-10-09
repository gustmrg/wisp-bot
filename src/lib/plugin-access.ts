import {
  PLUGIN_CATALOG,
  WEB_CAPABILITIES,
  isWebProvider,
  pluginCatalogEntry,
  type PluginAccess,
  type PluginGrant,
  type PluginId,
  type PluginSummary,
  type SaveWispPluginAccessRequest,
  type WebCapability,
  type WebProviders,
  type WispPluginAccessView,
} from "../../shared/plugins";
import type { WispAppearance } from "../../shared/wisp-appearance";

/** A Wisp that can receive plugin access from Settings. */
export interface WispOption {
  id: string;
  name: string;
  /** How the Wisp is drawn, for lists that show its picture. */
  appearance?: WispAppearance;
  color?: string;
}

/** Where the Access tab sends the user to connect or fix a service. */
export type IntegrationSettingsTarget = { section: "plugins"; pluginId?: PluginId } | { section: "mcp" };

export function isPluginAvailable(plugin: PluginSummary | undefined): boolean {
  return Boolean(plugin?.configured && plugin.enabled);
}

/**
 * Builds a save request in which a web provider is granted `read` only while one of
 * the Wisp's capabilities uses it, so access never outlives the provider choice.
 */
export function buildAccessRequest(
  view: Pick<WispPluginAccessView, "conversationId" | "revision">,
  grants: ReadonlyArray<PluginGrant>,
  webProviders: WebProviders,
): SaveWispPluginAccessRequest {
  const used = new Set(Object.values(webProviders));
  return {
    conversationId: view.conversationId,
    revision: view.revision,
    grants: PLUGIN_CATALOG.map(({ id }) => ({
      pluginId: id,
      access: isWebProvider(id)
        ? used.has(id)
          ? "read"
          : "none"
        : (grants.find((grant) => grant.pluginId === id)?.access ?? "none"),
    })),
    webProviders,
  };
}

/** Per-plugin choice in Settings: an access level, or the capabilities a web provider serves. */
export function pluginChoice(view: WispPluginAccessView, pluginId: PluginId): string {
  if (!isWebProvider(pluginId)) return view.grants.find((grant) => grant.pluginId === pluginId)?.access ?? "none";
  const capabilities = WEB_CAPABILITIES.filter(({ id }) => view.webProviders[id] === pluginId).map(({ id }) => id);
  return capabilities.length ? capabilities.join("+") : "none";
}

export function pluginChoiceOptions(pluginId: PluginId): Array<{ value: string; label: string }> {
  const plugin = pluginCatalogEntry(pluginId);
  if (!isWebProvider(pluginId))
    return [
      { value: "none", label: "No access" },
      { value: "read", label: "Read only" },
      ...(plugin.supportsWrite ? [{ value: "write", label: "Read and write" }] : []),
    ];
  const capabilities = WEB_CAPABILITIES.filter(({ id }) => plugin.capabilities.includes(id));
  return [
    { value: "none", label: "No access" },
    ...(capabilities.length > 1
      ? [{ value: capabilities.map(({ id }) => id).join("+"), label: "Search and reading" }]
      : []),
    ...capabilities.map(({ id, shortName }) => ({
      value: id,
      label: capabilities.length > 1 ? `${shortName} only` : shortName,
    })),
  ];
}

/** Applies a Settings choice for one plugin to a Wisp's access. */
export function applyPluginChoice(
  view: WispPluginAccessView,
  pluginId: PluginId,
  choice: string,
): SaveWispPluginAccessRequest {
  if (!isWebProvider(pluginId))
    return buildAccessRequest(
      view,
      view.grants.map((grant) => (grant.pluginId === pluginId ? { ...grant, access: choice as PluginAccess } : grant)),
      view.webProviders,
    );
  const selected = new Set(choice === "none" ? [] : (choice.split("+") as WebCapability[]));
  const webProviders = { ...view.webProviders };
  for (const { id } of WEB_CAPABILITIES) {
    if (selected.has(id)) webProviders[id] = pluginId;
    else if (webProviders[id] === pluginId) webProviders[id] = null;
  }
  return buildAccessRequest(view, view.grants, webProviders);
}

/** Providers a Settings choice would replace, such as "Brave Search for search". */
export function replacedProviders(
  view: WispPluginAccessView,
  pluginId: PluginId,
  choice: string,
  plugins: ReadonlyArray<PluginSummary>,
): string[] {
  if (!isWebProvider(pluginId) || choice === "none") return [];
  return WEB_CAPABILITIES.filter(({ id }) => {
    const current = view.webProviders[id];
    return choice.split("+").includes(id) && current && current !== pluginId;
  }).map(
    ({ id, shortName }) =>
      `${plugins.find((plugin) => plugin.id === view.webProviders[id])?.name ?? "another provider"} for ${shortName.toLowerCase()}`,
  );
}
