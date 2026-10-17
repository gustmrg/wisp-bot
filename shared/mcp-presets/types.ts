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
