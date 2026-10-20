import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import type { PluginToolMetadata } from "../shared/plugin-tools/types.js";
import type { PluginId } from "../shared/plugins.js";
import type { PluginOAuthConfig } from "./plugin-oauth.js";
import type { AgentScope } from "./integration-tool-source.js";

/** A bundled plugin tool; its name, labels and category come from the shared plugin tool metadata. */
export interface PluginToolSpec extends PluginToolMetadata {
  description: string;
  parameters: ToolDefinition["parameters"];
  access: "read" | "write";
  summarize: (params: unknown) => string;
  /**
   * `credential` is the API key, or the access token of a plugin that signs in.
   * `endpoint` is the instance address of a plugin that connects to one.
   */
  execute: (credential: string, params: unknown, signal?: AbortSignal, endpoint?: string) => Promise<string>;
}

export interface PluginAdapter {
  id: PluginId;
  tools: ReadonlyArray<PluginToolSpec>;
  testConnection: (credential: string, signal?: AbortSignal, endpoint?: string) => Promise<string>;
  /** Present for plugins that sign in through the browser with the user's OAuth client. */
  oauth?: PluginOAuthConfig;
}

export interface PluginToolSource {
  getTools(scope: AgentScope): ToolDefinition[];
  getActiveToolNames(wispId: string): Promise<string[]>;
}
