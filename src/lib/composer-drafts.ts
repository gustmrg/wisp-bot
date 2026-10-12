import type { WorkspaceAttachment } from "../../shared/workspace";

export interface ComposerDraft {
  text: string;
  attachments: ReadonlyArray<WorkspaceAttachment>;
}

const EMPTY: ComposerDraft = { text: "", attachments: [] };

// Kept outside React so a draft outlives the composer: the app remounts after a
// reconnect, and the composer remounts when another conversation is opened.
const drafts = new Map<string, ComposerDraft>();

export function readComposerDraft(conversationId: string): ComposerDraft {
  return drafts.get(conversationId) ?? EMPTY;
}

export function saveComposerDraft(conversationId: string, draft: ComposerDraft): void {
  if (draft.text || draft.attachments.length) drafts.set(conversationId, draft);
  else drafts.delete(conversationId);
}

export function clearComposerDrafts(): void {
  drafts.clear();
}
