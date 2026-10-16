/**
 * Plugins that run over a remote MCP connection. A preset fills in a known
 * server's endpoint, authentication, and options so the user only supplies a
 * credential; the result is an ordinary MCP connection with the same grants and
 * approvals, shown in Settings → Plugins instead of MCP servers. Wisps with
 * access to the connection also receive the plugin's skill.
 */
export const MCP_PRESET_IDS = ["github"] as const;
export type McpPresetId = (typeof MCP_PRESET_IDS)[number];

export interface McpPresetToolset {
  id: string;
  label: string;
  description: string;
  /** Part of the server's default set; selected when the connection is added. */
  default: boolean;
}

export interface McpPreset {
  id: McpPresetId;
  name: string;
  endpoint: string;
  description: string;
  /** Shown as a tag on the plugin card. */
  category: string;
  /** Header that carries the credential, with the prefix its value needs. */
  credentialHeader: { name: string; valuePrefix: string };
  credentialLabel: string;
  credentialHelpUrl: string;
  credentialHelp: string;
  /** Additional header that selects toolsets, as a comma-separated list. */
  toolsetHeader: string;
  /** Always sent; the user cannot turn these off. */
  requiredToolsets: ReadonlyArray<string>;
  toolsets: ReadonlyArray<McpPresetToolset>;
}

export const GITHUB_MCP_PRESET: McpPreset = {
  id: "github",
  name: "GitHub",
  endpoint: "https://api.githubcopilot.com/mcp/",
  description: "Repositories, issues, and pull requests through GitHub's official MCP server.",
  category: "Development",
  credentialHeader: { name: "Authorization", valuePrefix: "Bearer " },
  credentialLabel: "Personal access token",
  credentialHelpUrl: "https://github.com/settings/personal-access-tokens/new",
  credentialHelp:
    "A fine-grained token limited to the repositories and permissions your Wisps need. Organizations can restrict tokens and MCP use.",
  toolsetHeader: "X-MCP-Toolsets",
  requiredToolsets: ["context"],
  toolsets: [
    { id: "repos", label: "Repositories", description: "Files, branches, commits, and code search", default: true },
    { id: "issues", label: "Issues", description: "Read, create, and comment on issues", default: true },
    { id: "pull_requests", label: "Pull requests", description: "Read, create, review, and merge", default: true },
    { id: "users", label: "Users", description: "Search users", default: true },
    { id: "labels", label: "Labels", description: "Repository labels", default: false },
    { id: "actions", label: "Actions", description: "Workflows, runs, and logs", default: false },
    { id: "notifications", label: "Notifications", description: "Your GitHub notifications", default: false },
    { id: "discussions", label: "Discussions", description: "Repository discussions", default: false },
    { id: "projects", label: "Projects", description: "GitHub Projects", default: false },
    { id: "code_security", label: "Code scanning", description: "Code scanning alerts", default: false },
    { id: "dependabot", label: "Dependabot", description: "Dependabot alerts", default: false },
  ],
};

export const MCP_PRESETS: Readonly<Record<McpPresetId, McpPreset>> = { github: GITHUB_MCP_PRESET };

export function isMcpPresetId(value: unknown): value is McpPresetId {
  return typeof value === "string" && (MCP_PRESET_IDS as ReadonlyArray<string>).includes(value);
}

/** The toolset header value for a selection; required toolsets come first. */
export function presetToolsetHeaderValue(preset: McpPreset, selected: ReadonlyArray<string>): string {
  const known = new Set(preset.toolsets.map(({ id }) => id));
  const chosen = preset.toolsets.map(({ id }) => id).filter((id) => selected.includes(id) && known.has(id));
  return [...preset.requiredToolsets, ...chosen].join(",");
}

/** The selected toolsets read back from a saved header value; unknown entries are ignored. */
export function presetToolsetsFromHeader(preset: McpPreset, value: string | undefined): string[] {
  if (value === undefined) return preset.toolsets.filter((toolset) => toolset.default).map(({ id }) => id);
  const entries = value.split(",").map((entry) => entry.trim());
  return preset.toolsets.map(({ id }) => id).filter((id) => entries.includes(id));
}
