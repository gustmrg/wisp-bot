const PREFIX = "wisp-draft-v1:";
const MAX_DRAFT_LENGTH = 32_000;
function key(instanceId: string, conversationId: string): string {
  return `${PREFIX}${encodeURIComponent(instanceId)}:${encodeURIComponent(conversationId)}`;
}
export function loadDraft(instanceId: string, conversationId: string): string {
  try {
    return (localStorage.getItem(key(instanceId, conversationId)) ?? "").slice(0, MAX_DRAFT_LENGTH);
  } catch {
    return "";
  }
}
export function saveDraft(instanceId: string, conversationId: string, draft: string): void {
  try {
    if (draft) localStorage.setItem(key(instanceId, conversationId), draft.slice(0, MAX_DRAFT_LENGTH));
    else localStorage.removeItem(key(instanceId, conversationId));
  } catch {
    /* A draft remains in memory when storage is unavailable. */
  }
}
export function clearInstanceDrafts(instanceId: string): void {
  const prefix = `${PREFIX}${encodeURIComponent(instanceId)}:`;
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const item = localStorage.key(index);
      if (item?.startsWith(prefix)) localStorage.removeItem(item);
    }
  } catch {
    /* Storage may be disabled by the browser. */
  }
}

export interface PendingAdmission {
  conversationId: string;
  text: string;
}
function pendingPrefix(instanceId: string): string {
  return `${PREFIX}${encodeURIComponent(instanceId)}:pending-request:`;
}
/** Request identity is device draft metadata, never an authentication credential. */
export function loadPendingAdmissions(instanceId: string): Map<string, PendingAdmission> {
  const admissions = new Map<string, PendingAdmission>();
  const prefix = pendingPrefix(instanceId);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const item = localStorage.key(index);
      if (!item?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(item);
      if (!raw || raw.length > 132_000) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      const conversationId = Reflect.get(parsed, "conversationId");
      const text = Reflect.get(parsed, "text");
      const requestId = item.slice(prefix.length);
      if (
        requestId.length > 0 &&
        requestId.length <= 200 &&
        typeof conversationId === "string" &&
        conversationId.length > 0 &&
        conversationId.length <= 200 &&
        typeof text === "string" &&
        text.length > 0 &&
        text.length <= 131_072
      ) {
        admissions.set(requestId, { conversationId, text });
      }
    }
  } catch {
    // The write before any POST still fails closed if device storage is unavailable.
  }
  return admissions;
}
export function savePendingAdmission(instanceId: string, requestId: string, request: PendingAdmission): boolean {
  try {
    localStorage.setItem(`${pendingPrefix(instanceId)}${requestId}`, JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}
export function removePendingAdmission(instanceId: string, requestId: string): void {
  try {
    localStorage.removeItem(`${pendingPrefix(instanceId)}${requestId}`);
  } catch {
    // A retained identity only causes an idempotent recovery of the same request.
  }
}
