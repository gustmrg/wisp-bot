import type { McpPreset } from "./types.js";

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
