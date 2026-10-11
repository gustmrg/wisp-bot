# Plugin extensibility analysis

Date: 2026-10-11. Status: deferred proposal; application behavior is unchanged.
Nothing here is decided. Revisit it before writing an ADR.

## Goal

Let users write their own plugins in TypeScript, install them in Wisp, and
eventually share them through a community marketplace. Today the five bundled
plugins are compiled into the application, and remote MCP servers are the only
user-extensible integrations (see [plugins](plugins.md) and
[ADR 004](decisions/004-wisp-plugins.md)).

## The principal obstacle: third-party code has no boundary

Bundled adapters run in the main process. The guarantees in ADR 004 — fixed
endpoints, rejected redirects, timeouts and response limits, sanitized errors,
no plugin reading another plugin's key — hold because each adapter was written
and reviewed in this repository. A community plugin loaded the same way would
have full access to the file system, `plugin-credentials.enc.json`, model
credentials, and child processes.

Most of the work is therefore a runtime in which plugin code has no ambient
authority and can only use what the host hands it.

## Proposed shape

### Package format

Authors write TypeScript; the application loads a prebuilt JavaScript bundle,
so it does not ship a TypeScript compiler and installs exactly what was
reviewed. A package contains a manifest, the bundle, and a logo.

```jsonc
// wisp-plugin.json
{
  "id": "acme.jira",
  "version": "1.2.0",
  "apiVersion": 1,
  "name": "Jira",
  "category": "productivity",
  "credential": {
    "label": "Jira API token",
    "url": "https://id.atlassian.com/manage-profile/security/api-tokens",
    "inject": { "header": "Authorization", "format": "Bearer {key}" }
  },
  "network": ["*.atlassian.net"],
  "provides": [],
  "tools": [{ "name": "search_issues", "access": "read", "parameters": { /* JSON Schema */ } }]
}
```

```ts
// src/index.ts, built with a published @wisp-bot/plugin-sdk
export default definePlugin({
  async testConnection(ctx) {
    await ctx.fetch("https://example.atlassian.net/rest/api/3/myself");
    return "Connected.";
  },
  tools: {
    async search_issues(params, ctx) {
      const response = await ctx.fetch(/* ... */);
      return formatIssues(await response.json());
    },
  },
});
```

The SDK is essentially a public version of `PluginAdapter` in
`backend/plugin-types.ts`, with one difference: plugin code never receives the
API key. It calls `ctx.fetch`, and the host injects the credential into the
header the manifest declares, only for hosts in `network`.

### Isolated runtime

Options considered:

| Option | Assessment |
| --- | --- |
| Node `vm` in the main process | Not a security boundary. Rejected. |
| JavaScript sandbox without Node APIs (for example QuickJS compiled to WASM) in a worker or `utilityProcess` | Preferred. `ctx.fetch` is the only way out; portable, no native module. Needs async host calls and per-call CPU/memory limits. |
| Existing container sandbox with the egress proxy (`backend/container-manager.ts`, `backend/egress-proxy.ts`) | Strong isolation, but makes plugins depend on a container runtime. |

Moving network rules into the host's `ctx.fetch` is a benefit in itself: the
timeouts, redirect rejection, response limits, host allowlist, and error
sanitization now repeated across `backend/plugin-adapters.ts` would apply to
every plugin without each one reimplementing them.

### Dynamic plugin identity

- `PluginId` is a literal union (`shared/plugins.ts`) referenced from about 15
  files in `src/`, `backend/`, and `shared/`. It becomes a validated, namespaced
  string; bundled IDs (`web-search`, `linear`, ...) keep their values so saved
  grants stay valid.
- `PLUGIN_CATALOG` becomes the bundled catalog plus a registry of installed
  plugins.
- `shared/tool-catalog.ts` holds static metadata per `pluginId`. Installed
  plugins supply theirs through the snapshot instead.
  `IntegrationToolSnapshot` (`backend/integration-tool-source.ts`) already
  carries dynamic definitions and metadata for MCP tools, and
  `PluginService.getSnapshot` already implements it.
- Tool names need a namespace (for example `acme_jira__search_issues`). A
  collision currently throws in `PluginService.getTools`.
- Logos are imported per plugin in `src/components/plugin-logo.tsx`; installed
  plugins serve theirs from the package.
- `plugins.json` needs a schema migration that keeps today's recovery from
  corrupt configuration (plugins disabled, access denied).

### Permissions and approvals

- Per-Wisp grants, the authorization broker for writes, revocation, and
  cancellation stay host-enforced and unchanged in concept.
- The host cannot verify that a tool declared `read` only reads; search APIs use
  POST too. The classification rests on trust, which is one reason a
  marketplace needs review.
- Installation shows the declared network hosts and tools. An update that widens
  `network` or adds `write` tools requires consent again, as browser extensions
  do.
- A plugin declaring `provides: ["search"]` or `["read"]` becomes a candidate
  provider for `web_search` / `web_read`; the host validates its output against
  the shared web tool contract.

### Lifecycle

- Install from a folder or archive in a developer mode first; store under
  `userData/plugins/<id>/<version>` with a content hash.
- Uninstalling clears grants and the credential, as **Remove connection** does.
- Refuse packages with an incompatible `apiVersion`.
- The headless server (`backend/runtime.ts` is shared) keeps its own installed
  plugins; nothing is synchronized between environments.
- Tests use fake `ctx.fetch` responses and never reach real hosts.

### Marketplace

An index (a GitHub repository with JSON, or npm packages with a keyword),
signed packages, review, and a revocation list the application checks so a
malicious plugin can be disabled remotely.

## Suggested sequence

1. Internal refactor with no visible change: dynamic `PluginId`, manifest, and
   host `ctx.fetch`, migrating the five bundled plugins to the same contract.
   This validates the API before opening it.
2. Sandboxed runtime and **Load local plugin** in developer mode.
3. Published SDK and scaffold (`npm create wisp-plugin`).
4. Marketplace.

## Open question

Remote MCP servers already let users add integrations. Native plugins would be a
second extension system. They offer one-click installation without hosting, plus
network and credential guarantees MCP cannot give, at the cost of maintaining a
runtime and a stable public API. With a community marketplace as the goal, that
trade-off looks worthwhile, but it should be confirmed when this is revisited.
