import type { McpPreset } from "./types.js";

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
