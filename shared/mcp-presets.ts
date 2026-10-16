/**
 * Plugins that run over a remote MCP connection. A preset fills in a known
 * server's endpoint, authentication, and options so the user only supplies a
 * credential; the result is an ordinary MCP connection with the same grants and
 * approvals, shown in Settings → Plugins instead of MCP servers and without
 * mentioning MCP: the user configures a plugin, not a server. Wisps with
 * access to the connection also receive the plugin's skill.
 */
export const MCP_PRESET_IDS = ["github", "atlassian"] as const;
export type McpPresetId = (typeof MCP_PRESET_IDS)[number];

export interface McpPresetToolset {
  id: string;
  label: string;
  description: string;
  /** Part of the server's default set; selected when the connection is added. */
  default: boolean;
}

/** A token the user pastes, sent in a header. */
export interface McpPresetTokenAuth {
  mode: "header";
  /** Header that carries the credential, with the prefix its value needs. */
  header: { name: string; valuePrefix: string };
  label: string;
  helpUrl: string;
  help: string;
}

/** A browser sign-in; the user approves access on the provider's site. */
export interface McpPresetSignInAuth {
  mode: "oauth";
  /** What the user approves, shown before the browser opens. */
  help: string;
}

/** Toolsets the user picks, sent as a comma-separated list in a header. */
export interface McpPresetToolsets {
  header: string;
  /** Always sent; the user cannot turn these off. */
  required: ReadonlyArray<string>;
  options: ReadonlyArray<McpPresetToolset>;
}

export interface McpPreset {
  id: McpPresetId;
  name: string;
  endpoint: string;
  description: string;
  /** Shown as a tag on the plugin card. */
  category: string;
  auth: McpPresetTokenAuth | McpPresetSignInAuth;
  toolsets?: McpPresetToolsets;
}

export const GITHUB_MCP_PRESET: McpPreset = {
  id: "github",
  name: "GitHub",
  endpoint: "https://api.githubcopilot.com/mcp/",
  description: "Work with repositories, issues, and pull requests on GitHub.",
  category: "Development",
  auth: {
    mode: "header",
    header: { name: "Authorization", valuePrefix: "Bearer " },
    label: "Personal access token",
    helpUrl: "https://github.com/settings/personal-access-tokens/new",
    help: "A fine-grained token limited to the repositories and permissions your Wisps need. Organizations can restrict which tokens work.",
  },
  toolsets: {
    header: "X-MCP-Toolsets",
    required: ["context"],
    options: [
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
  },
};

export const ATLASSIAN_MCP_PRESET: McpPreset = {
  id: "atlassian",
  name: "Atlassian",
  endpoint: "https://mcp.atlassian.com/v1/mcp",
  description: "Work with Jira issues and Confluence pages on your Atlassian sites.",
  category: "Productivity",
  auth: {
    mode: "oauth",
    help: "You sign in to Atlassian in your browser and choose the site to allow. Wisps act as you, with your Jira and Confluence permissions. Site admins can restrict which apps may connect.",
  },
};

export const MCP_PRESETS: Readonly<Record<McpPresetId, McpPreset>> = {
  github: GITHUB_MCP_PRESET,
  atlassian: ATLASSIAN_MCP_PRESET,
};

export function isMcpPresetId(value: unknown): value is McpPresetId {
  return typeof value === "string" && (MCP_PRESET_IDS as ReadonlyArray<string>).includes(value);
}

/** The toolset header value for a selection; required toolsets come first. */
export function presetToolsetHeaderValue(toolsets: McpPresetToolsets, selected: ReadonlyArray<string>): string {
  const chosen = toolsets.options.map(({ id }) => id).filter((id) => selected.includes(id));
  return [...toolsets.required, ...chosen].join(",");
}

/** The selected toolsets read back from a saved header value; unknown entries are ignored. */
export function presetToolsetsFromHeader(toolsets: McpPresetToolsets, value: string | undefined): string[] {
  if (value === undefined) return toolsets.options.filter((toolset) => toolset.default).map(({ id }) => id);
  const entries = value.split(",").map((entry) => entry.trim());
  return toolsets.options.map(({ id }) => id).filter((id) => entries.includes(id));
}
