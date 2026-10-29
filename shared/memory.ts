/** Memory as settings show it (ADR 029). The backend's memory module has the same shapes. */

export type MemoryScope = "user" | "wisp";
export type MemorySource = "owner" | "agent";
export type MemoryStatus = "active" | "superseded" | "removed";

export const MEMORY_SCOPES: ReadonlyArray<MemoryScope> = ["user", "wisp"];

export interface MemoryEntryView {
  id: string;
  scope: MemoryScope;
  wispId: string | null;
  text: string;
  source: MemorySource;
  status: MemoryStatus;
  /** The entry a patch superseded to create this one. */
  replaces: string | null;
  observedAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUsageView {
  scope: MemoryScope;
  used: number;
  limit: number;
}

/** A Wisp's memory: the person's entries and its own, in every status, `user` first. The person's alone has only `user`. */
export interface MemoryView {
  entries: ReadonlyArray<MemoryEntryView>;
  usage: ReadonlyArray<MemoryUsageView>;
}

/** A change the person makes in settings; a batch applies in one transaction. */
export type MemoryOperationRequest =
  | { op: "add"; scope: MemoryScope; text: string; expiresAt?: string | null }
  | { op: "patch"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "restore"; id: string };

/** Whose memory settings show: a Wisp's, by its conversation, or without one the person's own (`user` only). */
export interface MemoryRequest {
  conversationId?: string;
}

export interface ApplyMemoryRequest extends MemoryRequest {
  operations: ReadonlyArray<MemoryOperationRequest>;
}

export interface ExportMemoryRequest extends MemoryRequest {
  scope: MemoryScope;
}

export interface MemoryExport {
  fileName: string;
  markdown: string;
}

/** Most operations one batch may carry; an edit as text of a full scope stays well under it. */
export const MAX_MEMORY_OPERATIONS = 500;
/** Longest text an operation may carry; the scope's limit is the real bound. */
export const MAX_MEMORY_TEXT_LENGTH = 4000;
