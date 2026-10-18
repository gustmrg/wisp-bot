import type { PluginToolMetadata } from "./types.js";

export const GOOGLE_DRIVE_TOOL_METADATA = {
  searchFiles: {
    name: "google_drive_search_files",
    label: "Search Google Drive",
    activityLabel: "Searching Google Drive…",
    category: "search",
  },
  getFile: {
    name: "google_drive_get_file",
    label: "Get Drive file details",
    activityLabel: "Reading file details…",
    category: "read",
  },
  readFile: {
    name: "google_drive_read_file",
    label: "Read Drive file",
    activityLabel: "Reading a Drive file…",
    category: "read",
  },
  createFile: {
    name: "google_drive_create_file",
    label: "Create Drive file",
    activityLabel: "Creating a file in Drive…",
    category: "external_write",
  },
  updateFile: {
    name: "google_drive_update_file",
    label: "Update Drive file",
    activityLabel: "Updating a Drive file…",
    category: "external_write",
  },
  createFolder: {
    name: "google_drive_create_folder",
    label: "Create Drive folder",
    activityLabel: "Creating a folder in Drive…",
    category: "external_write",
  },
} as const satisfies Record<string, PluginToolMetadata>;
