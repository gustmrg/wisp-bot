import type { McpPreset } from "./types.js";

export const GITLAB_MCP_PRESET: McpPreset = {
  id: "gitlab",
  name: "GitLab",
  endpoint: "https://gitlab.com/api/v4/mcp",
  description: "Work with projects, merge requests, issues, and pipelines on GitLab.com or your own GitLab.",
  category: "Development",
  auth: {
    mode: "header",
    header: { name: "Authorization", valuePrefix: "Bearer " },
    label: "Personal access token",
    helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    help: "A fine-grained token with the Execute permission on the MCP server, limited to the projects your Wisps need. Legacy tokens are refused. The top-level group's owner, or your instance's administrator, must allow access to the MCP server.",
  },
  toolsets: {
    header: "X-Gitlab-Enabled-Mcp-Server-Toolsets",
    required: [],
    options: [
      { id: "core", label: "Core", description: "Projects, groups, users, and search", default: true },
      { id: "repository", label: "Repository", description: "Files, branches, and commits", default: true },
      { id: "merge_requests", label: "Merge requests", description: "Read, create, review, and merge", default: true },
      { id: "work_items", label: "Work items", description: "Issues, epics, and tasks", default: true },
      { id: "ci", label: "CI/CD", description: "Pipelines and jobs", default: true },
      { id: "wikis", label: "Wikis", description: "Project and group wikis", default: false },
      { id: "code_security", label: "Code security", description: "Vulnerabilities (Ultimate)", default: false },
    ],
  },
  instance: {
    label: "GitLab address",
    help: "GitLab.com, or the address of your GitLab Self-Managed or Dedicated instance. The MCP server needs GitLab 18.6 or later.",
    path: "/api/v4/mcp",
  },
};
