/** Who a memory is about: the person, shared by every Wisp, or one Wisp (ADR 029). */
export type MemoryScope = "user" | "wisp";

/** Who wrote an entry: the person in settings, or a Wisp through `save_memory`. */
export type MemorySource = "owner" | "agent";

/** Removed and superseded entries are kept so the person can restore them. */
export type MemoryStatus = "active" | "superseded" | "removed";

export interface MemoryEntry {
  /** Short and stable (`m12`), shown to the model so it can patch or remove the entry. */
  id: string;
  scope: MemoryScope;
  /** The Wisp a `wisp` entry belongs to; null for `user` entries. */
  wispId: string | null;
  /** One line, a declarative fact. */
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

/**
 * One change to memory. A batch of them applies in one transaction, in order,
 * each seeing the ones before it. `save_memory` offers add, patch and remove;
 * restore is for settings.
 */
export type MemoryOperation =
  | { op: "add"; scope: MemoryScope; text: string; expiresAt?: string | null }
  | { op: "patch"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "restore"; id: string };

/** Where a batch applies and who is writing it. */
export interface MemoryWriteContext {
  /** The Wisp whose `wisp` scope is reachable; its entries and the `user` ones are the only ones a batch can touch. */
  wispId: string;
  source: MemorySource;
}

export interface MemoryUsage {
  scope: MemoryScope;
  /** Characters in the scope's active, unexpired entries. */
  used: number;
  limit: number;
}

export type MemoryErrorCode = "invalid_text" | "secret" | "not_found" | "invalid_state" | "duplicate" | "over_limit";

export interface MemoryErrorDetails {
  code: MemoryErrorCode;
  message: string;
  /** The operation that failed, by position in the batch. */
  operation?: number;
  /** For `over_limit`: the scope's entries before the batch, so the writer can choose what to drop. */
  scope?: MemoryScope;
  limit?: number;
  /** For `over_limit`: how many characters the batch must free. */
  excess?: number;
  entries?: MemoryEntry[];
}
