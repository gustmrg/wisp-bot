import type { PluginToolMetadata } from "./types.js";

export const GMAIL_TOOL_METADATA = {
  searchMessages: {
    name: "gmail_search_messages",
    label: "Search Gmail",
    activityLabel: "Searching Gmail…",
    category: "search",
  },
  readMessage: {
    name: "gmail_read_message",
    label: "Read email",
    activityLabel: "Reading an email…",
    category: "read",
  },
  readThread: {
    name: "gmail_read_thread",
    label: "Read email thread",
    activityLabel: "Reading an email thread…",
    category: "read",
  },
  listLabels: {
    name: "gmail_list_labels",
    label: "List Gmail labels",
    activityLabel: "Listing Gmail labels…",
    category: "read",
  },
  listDrafts: {
    name: "gmail_list_drafts",
    label: "List Gmail drafts",
    activityLabel: "Listing drafts…",
    category: "read",
  },
  createDraft: {
    name: "gmail_create_draft",
    label: "Create email draft",
    activityLabel: "Writing a draft…",
    category: "external_write",
  },
  updateDraft: {
    name: "gmail_update_draft",
    label: "Update email draft",
    activityLabel: "Updating a draft…",
    category: "external_write",
  },
} as const satisfies Record<string, PluginToolMetadata>;
