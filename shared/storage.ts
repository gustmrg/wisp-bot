/** Largest page of directory entries the inspector returns. */
export const STORAGE_PAGE_SIZE = 200;
/** Most paths one cleanup may name. */
export const MAX_CLEANUP_PATHS = 500;
/** Most archive entries one permanent deletion may name. */
export const MAX_ARCHIVE_DELETIONS = 100;

/**
 * Sizes are the logical length of regular files, not the space allocated on
 * disk: hardlinks, sparse files and the filesystem itself can make the two differ.
 */
export interface StorageWorkspace {
  conversationId: string;
  name: string;
  kind: "wisp" | "circle";
  usedBytes: number;
  fileCount: number;
  quotaBytes: number;
  /** Some folders or files could not be read, so the numbers are a lower bound. */
  partial: boolean;
}

export interface StorageArchive {
  /** Names the archive folder on the server; never a path. */
  id: string;
  usedBytes: number;
  fileCount: number;
  /** When the conversation was archived, from the folder's own timestamp; null when unknown. */
  archivedAt: string | null;
  partial: boolean;
}

export interface StorageSummary {
  /** ISO 8601 time the measurement finished. */
  measuredAt: string;
  /** Largest first. A conversation shared by several Wisps appears once. */
  workspaces: ReadonlyArray<StorageWorkspace>;
  workspaceBytes: number;
  archives: ReadonlyArray<StorageArchive>;
  archiveBytes: number;
  partial: boolean;
}

export interface StorageSummaryRequest {
  /** Measure again instead of reusing a recent measurement. */
  refresh?: boolean;
}

export interface StorageDirectoryRequest {
  conversationId: string;
  /** Folder inside the workspace, relative and with forward slashes; empty for its root. */
  path: string;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

export type StorageEntryType = "file" | "directory" | "link" | "other";

export interface StorageEntry {
  name: string;
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  type: StorageEntryType;
  /** Logical bytes; for a folder, everything inside it. */
  size: number;
  fileCount: number;
  modifiedAt: string | null;
  /** The size could not be fully read. */
  partial: boolean;
}

export interface StorageDirectoryPage {
  path: string;
  /** Largest first. */
  entries: ReadonlyArray<StorageEntry>;
  nextCursor: string | null;
}

export interface StorageCleanupRequest {
  conversationId: string;
  paths: ReadonlyArray<string>;
}

export interface StorageCleanupPreview {
  items: ReadonlyArray<StorageEntry>;
  totalBytes: number;
  fileCount: number;
  /** Pass back with the same paths; a different value means the files changed after the preview. */
  fingerprint: string;
  /** Whether any selected path is in the inbox, where messages may refer to attachments. */
  includesInbox: boolean;
}

export interface StorageCleanupConfirmation extends StorageCleanupRequest {
  fingerprint: string;
}

export interface StorageCleanupResult {
  removed: ReadonlyArray<string>;
  failed: ReadonlyArray<{ path: string; message: string }>;
  /** Logical bytes of the removed items, not space recovered on disk. */
  removedBytes: number;
}

export interface StorageArchiveDeletionRequest {
  ids: ReadonlyArray<string>;
}

export interface StorageArchiveDeletionResult {
  removed: ReadonlyArray<string>;
  failed: ReadonlyArray<{ id: string; message: string }>;
}
