const STORAGE_KEY = "wisp.pendingEnvironmentOpen";
const MAX_AGE_MS = 60_000;

export interface PendingEnvironmentOpen {
  environmentId: string;
  conversationId: string;
  openDetails?: boolean;
  createdAt: number;
}

let memoryFallback: PendingEnvironmentOpen | null = null;

/**
 * Remembers a conversation to open immediately after `activateConnection`
 * switches environments and `ConnectionGate` remounts the workspace.
 */
export function setPendingEnvironmentOpen(target: Omit<PendingEnvironmentOpen, "createdAt">): void {
  const entry: PendingEnvironmentOpen = { ...target, createdAt: Date.now() };
  memoryFallback = entry;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Restricted storage falls back to in-memory state within the same page session.
  }
}

export function clearPendingEnvironmentOpen(): void {
  memoryFallback = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage access errors.
  }
}

/**
 * Reads and clears a pending conversation target if it matches `environmentId`
 * and has not expired.
 */
export function consumePendingEnvironmentOpen(environmentId: string): PendingEnvironmentOpen | null {
  let entry = memoryFallback;
  if (!entry) {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) entry = JSON.parse(raw) as PendingEnvironmentOpen;
    } catch {
      entry = null;
    }
  }
  if (!entry) return null;
  if (Date.now() - entry.createdAt > MAX_AGE_MS) {
    clearPendingEnvironmentOpen();
    return null;
  }
  if (entry.environmentId !== environmentId) return null;
  clearPendingEnvironmentOpen();
  return entry;
}

/**
 * Opens a conversation in another environment: switches to it, and the
 * remounted workspace opens the conversation once it loads. Resolves with an
 * error message, or null.
 */
export async function openEnvironmentChat(
  environmentId: string,
  conversationId: string,
  options?: { openDetails?: boolean },
): Promise<string | null> {
  setPendingEnvironmentOpen({ environmentId, conversationId, ...(options?.openDetails ? { openDetails: true } : {}) });
  try {
    const result = await window.wisp.activateConnection({ id: environmentId });
    if (result.ok) return null;
    clearPendingEnvironmentOpen();
    return result.error.message;
  } catch {
    clearPendingEnvironmentOpen();
    return "The environment could not be switched.";
  }
}
