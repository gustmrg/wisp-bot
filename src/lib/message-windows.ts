import type { ConversationDelta, Message, MessagePage } from "../../shared/conversations";

/** The open conversation and the four opened most recently before it keep their windows. */
export const MAX_MESSAGE_WINDOWS = 5;

/**
 * The part of a conversation's transcript the renderer holds. It grows a page
 * at a time at either end. A window that reaches the newest message is
 * attached: new messages join it as they arrive.
 */
export interface MessageWindow {
  /** Changes when the window is loaded afresh, as opposed to extended or updated. */
  epoch: number;
  /** Oldest first. */
  messages: ReadonlyArray<Message>;
  olderCursor: string | null;
  newerCursor: string | null;
  loading: boolean;
  /** The message the window was opened on (a search result), to scroll to and highlight. */
  targetMessageId?: string;
}

export function isAttached(window: Pick<MessageWindow, "newerCursor">): boolean {
  return window.newerCursor === null;
}

export function windowFromPage(epoch: number, page: MessagePage, targetMessageId?: string): MessageWindow {
  return {
    epoch,
    messages: page.messages,
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    loading: false,
    ...(targetMessageId ? { targetMessageId } : {}),
  };
}

/** Adds an older or newer page at its end of the window, skipping messages the window already holds. */
export function extendWindow(window: MessageWindow, direction: "older" | "newer", page: MessagePage): MessageWindow {
  const held = new Set(window.messages.flatMap(({ id }) => (id ? [id] : [])));
  const fresh = page.messages.filter(({ id }) => !id || !held.has(id));
  return direction === "older"
    ? { ...window, messages: [...fresh, ...window.messages], olderCursor: page.olderCursor, loading: false }
    : { ...window, messages: [...window.messages, ...fresh], newerCursor: page.newerCursor, loading: false };
}

/**
 * Applies a change to a window. Messages the window holds are replaced in
 * place; new messages join only an attached window, because a detached one
 * reaches them by loading newer pages. Applying the same change twice is safe.
 */
export function applyDeltaToWindow(
  window: MessageWindow,
  delta: Pick<ConversationDelta, "added" | "updated">,
): MessageWindow {
  const changed = new Map([...delta.updated, ...delta.added].flatMap((message) => messageEntry(message)));
  if (changed.size === 0) return window;
  const held = new Set<string>();
  const messages = window.messages.map((message) => {
    const next = message.id ? changed.get(message.id) : undefined;
    if (!next?.id) return message;
    held.add(next.id);
    return next;
  });
  const appended = isAttached(window) ? delta.added.filter(({ id }) => !id || !held.has(id)) : [];
  if (held.size === 0 && appended.length === 0) return window;
  return { ...window, messages: [...messages, ...appended] };
}

/**
 * Moves a conversation to the front of the most-recently-opened list and
 * names the conversations that fall off its end, whose windows are dropped.
 */
export function touchOpened(
  opened: ReadonlyArray<string>,
  conversationId: string,
): { opened: ReadonlyArray<string>; evicted: ReadonlyArray<string> } {
  const next = [conversationId, ...opened.filter((id) => id !== conversationId)];
  return { opened: next.slice(0, MAX_MESSAGE_WINDOWS), evicted: next.slice(MAX_MESSAGE_WINDOWS) };
}

function messageEntry(message: Message): Array<[string, Message]> {
  return message.id ? [[message.id, message]] : [];
}
