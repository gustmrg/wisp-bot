import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import type { PluginId } from "../shared/plugins.js";

export interface PluginToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  access: "read" | "write";
  summarize: (params: unknown) => string;
  execute: (apiKey: string, params: unknown, signal?: AbortSignal) => Promise<string>;
}

export interface PluginAdapter {
  id: PluginId;
  tools: ReadonlyArray<PluginToolSpec>;
  testConnection: (apiKey: string, signal?: AbortSignal) => Promise<string>;
}

export interface PluginToolSource {
  getTools(conversationId: string): ToolDefinition[];
  getActiveToolNames(conversationId: string): Promise<string[]>;
}
