import type { PluginToolMetadata } from "./types.js";

export const LINEAR_TOOL_METADATA = {
  searchIssues: {
    name: "linear_search_issues",
    label: "Search Linear issues",
    activityLabel: "Searching Linear issues…",
    category: "search",
  },
  getIssue: {
    name: "linear_get_issue",
    label: "Read Linear issue",
    activityLabel: "Reading a Linear issue…",
    category: "read",
  },
  listComments: {
    name: "linear_list_comments",
    label: "List Linear comments",
    activityLabel: "Reading Linear comments…",
    category: "read",
  },
  listProjects: {
    name: "linear_list_projects",
    label: "List Linear projects",
    activityLabel: "Listing Linear projects…",
    category: "read",
  },
  listLabels: {
    name: "linear_list_labels",
    label: "List Linear labels",
    activityLabel: "Listing Linear labels…",
    category: "read",
  },
  listUsers: {
    name: "linear_list_users",
    label: "List Linear users",
    activityLabel: "Listing Linear users…",
    category: "read",
  },
  listTeams: {
    name: "linear_list_teams",
    label: "List Linear teams",
    activityLabel: "Listing Linear teams…",
    category: "read",
  },
  listStatuses: {
    name: "linear_list_statuses",
    label: "List Linear statuses",
    activityLabel: "Listing Linear statuses…",
    category: "read",
  },
  createIssue: {
    name: "linear_create_issue",
    label: "Create Linear issue",
    activityLabel: "Creating a Linear issue…",
    category: "external_write",
  },
  updateIssue: {
    name: "linear_update_issue",
    label: "Update Linear issue",
    activityLabel: "Updating a Linear issue…",
    category: "external_write",
  },
  addComment: {
    name: "linear_add_comment",
    label: "Comment on Linear issue",
    activityLabel: "Commenting on a Linear issue…",
    category: "external_write",
  },
} as const satisfies Record<string, PluginToolMetadata>;
