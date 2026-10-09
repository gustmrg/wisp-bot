import type { ModelSelection } from "../shared/contracts.js";
import type { Chat, ChatChanges, ChatId, Message, Wisp, WispChanges, WispId } from "../shared/conversations.js";
import { applyWispChanges, normalizeChat, upsertNormalizedMessage } from "./conversation-normalizer.js";

export interface WispRecord {
  wisp: Wisp;
  /**
   * Names the Wisp's own directory (skills, saved memory, agent settings) and
   * keys its integration grants. It is not the Wisp's ID, so a deleted Wisp's
   * archived files never collide with a new Wisp that reuses the ID.
   */
  storageId: string;
  modelOverride: ModelSelection | null;
  createdAt: string;
  updatedAt: string;
}

/** A Wisp's agent session in one conversation. */
export interface ParticipantSession {
  /** Names the session's directory. */
  sessionId: string;
  piSessionId: string | null;
  piSessionFile: string | null;
}

export interface ConversationRecord {
  chat: Chat;
  /** Names the conversation's workspace directory, shared by the Wisps in it. */
  storageId: string;
  /** The agent session of each Wisp in this conversation that has one. */
  sessions: Readonly<Record<WispId, ParticipantSession>>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecords {
  wisps: Readonly<Record<WispId, WispRecord>>;
  conversations: Readonly<Record<ChatId, ConversationRecord>>;
}

export type WorkspaceAction =
  | { type: "create-wisp"; wisp: WispRecord; conversation: ConversationRecord }
  | { type: "update-wisp"; wispId: WispId; changes: WispChanges; updatedAt: string }
  | { type: "delete-wisp"; wispId: WispId; updatedAt: string }
  | { type: "create"; record: ConversationRecord }
  | { type: "update"; conversationId: string; changes: ChatChanges; updatedAt: string }
  | { type: "replace-circle-members"; conversationId: string; memberIds: ReadonlyArray<string>; updatedAt: string }
  | { type: "delete"; conversationId: string; updatedAt: string }
  | { type: "mark-read"; conversationId: string; updatedAt: string }
  | { type: "mark-unread"; conversationId: string; updatedAt: string }
  | { type: "append-message"; conversationId: string; message: Message & { id: string }; updatedAt: string }
  | { type: "answer-prompt"; conversationId: string; messageId: string; answer: string; updatedAt: string };

export type WorkspaceActionStatus =
  | "applied"
  | "unchanged"
  | "not_found"
  | "already_exists"
  | "kind_mismatch"
  | "invalid_member"
  | "prompt_not_found";

export interface WorkspaceActionResult {
  records: WorkspaceRecords;
  status: WorkspaceActionStatus;
  /** What a delete removed: the conversation, and for a Wisp also the Wisp. */
  deleted?: { conversation: ConversationRecord; wisp?: WispRecord };
  /** Oldest messages an append dropped to stay within the per-conversation limit. */
  droppedOldestMessages?: number;
}

/** The chat's last activity: its newest timestamped message, else what it already had. */
export function lastActivityOf(chat: Pick<Chat, "messages" | "lastActivityAt">): string | undefined {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const createdAt = chat.messages[index]?.createdAt;
    if (createdAt) return createdAt;
  }
  return chat.lastActivityAt;
}

/** A new chat with its last activity derived from its messages, replacing any value it arrived with. */
export function withLastActivity<T extends Chat>(chat: T): T {
  const { lastActivityAt: _ignored, ...rest } = chat;
  const lastActivityAt = lastActivityOf({ messages: chat.messages });
  return (lastActivityAt ? { ...rest, lastActivityAt } : rest) as T;
}

// Later of two ISO times. Writes can arrive out of order (a delivery status
// update after a newer message), so activity never moves backwards.
function laterOf(current: string | undefined, candidate: string): string {
  return current && Date.parse(current) >= Date.parse(candidate) ? current : candidate;
}

// A finished reply (or one that failed) and a question from a Wisp are news
// for the person; their own messages, notices, and replies they stopped are not.
function marksUnread(message: Message): boolean {
  if (message.type === "prompt") return true;
  return message.type === "incoming" && message.status !== "streaming" && message.status !== "cancelled";
}

export function applyWorkspaceAction(records: WorkspaceRecords, action: WorkspaceAction): WorkspaceActionResult {
  switch (action.type) {
    case "create-wisp": {
      const id = action.wisp.wisp.id;
      if (records.wisps[id] || records.conversations[id]) return { records, status: "already_exists" };
      return {
        records: {
          wisps: { ...records.wisps, [id]: action.wisp },
          conversations: { ...records.conversations, [id]: action.conversation },
        },
        status: "applied",
      };
    }
    case "update-wisp": {
      const record = records.wisps[action.wispId];
      if (!record) return { records, status: "not_found" };
      return {
        records: {
          ...records,
          wisps: {
            ...records.wisps,
            [action.wispId]: {
              ...record,
              wisp: applyWispChanges(record.wisp, action.changes),
              updatedAt: action.updatedAt,
            },
          },
        },
        status: "applied",
      };
    }
    case "delete-wisp": {
      const wisp = records.wisps[action.wispId];
      const conversation = records.conversations[action.wispId];
      if (!wisp || !conversation) return { records, status: "not_found" };
      const { [action.wispId]: _wisp, ...wisps } = records.wisps;
      const conversations: Record<ChatId, ConversationRecord> = {};
      for (const [id, record] of Object.entries(records.conversations)) {
        if (id === action.wispId) continue;
        conversations[id] = withoutMember(record, action.wispId, action.updatedAt);
      }
      return { records: { wisps, conversations }, status: "applied", deleted: { conversation, wisp } };
    }
    case "create": {
      const id = action.record.chat.id;
      if (records.conversations[id] || records.wisps[id]) return { records, status: "already_exists" };
      return withConversation(records, id, action.record);
    }
    case "update": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      const { kind, ...fields } = action.changes;
      if (record.chat.kind !== kind) return { records, status: "kind_mismatch" };
      const chat = normalizeChat({ ...record.chat, ...fields });
      return withConversation(records, action.conversationId, { ...record, chat, updatedAt: action.updatedAt });
    }
    case "replace-circle-members": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      if (record.chat.kind !== "circle") return { records, status: "kind_mismatch" };
      const memberIds = [...new Set(action.memberIds)];
      if (memberIds.some((memberId) => !records.wisps[memberId])) return { records, status: "invalid_member" };
      return withConversation(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, memberIds },
        updatedAt: action.updatedAt,
      });
    }
    case "delete": {
      const conversation = records.conversations[action.conversationId];
      if (!conversation) return { records, status: "not_found" };
      // A Wisp's own conversation goes only with the Wisp.
      if (conversation.chat.kind !== "circle") return { records, status: "kind_mismatch" };
      const { [action.conversationId]: _deleted, ...conversations } = records.conversations;
      return { records: { ...records, conversations }, status: "applied", deleted: { conversation } };
    }
    case "mark-read": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      if (!record.chat.unread) return { records, status: "unchanged" };
      return withConversation(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, unread: false },
        updatedAt: action.updatedAt,
      });
    }
    case "mark-unread": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      if (record.chat.unread) return { records, status: "unchanged" };
      return withConversation(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, unread: true },
        updatedAt: action.updatedAt,
      });
    }
    case "append-message": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      const { chat, message, droppedOldest } = upsertNormalizedMessage(record.chat, action.message);
      return {
        ...withConversation(records, action.conversationId, {
          ...record,
          chat: {
            ...chat,
            preview: "text" in message ? message.text : chat.preview,
            ...(marksUnread(message) ? { unread: true } : {}),
            lastActivityAt: laterOf(chat.lastActivityAt, message.createdAt ?? action.updatedAt),
          },
          updatedAt: action.updatedAt,
        }),
        droppedOldestMessages: droppedOldest,
      };
    }
    case "answer-prompt": {
      const record = records.conversations[action.conversationId];
      if (!record) return { records, status: "not_found" };
      let found = false;
      const messages = record.chat.messages.map((message) => {
        if (message.id !== action.messageId || message.type !== "prompt") return message;
        found = true;
        return { ...message, answer: action.answer };
      });
      if (!found) return { records, status: "prompt_not_found" };
      return withConversation(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, messages },
        updatedAt: action.updatedAt,
      });
    }
    default:
      return assertNever(action);
  }
}

function withoutMember(record: ConversationRecord, wispId: WispId, updatedAt: string): ConversationRecord {
  if (record.chat.kind !== "circle" || !record.chat.memberIds.includes(wispId)) return record;
  const { [wispId]: _session, ...sessions } = record.sessions;
  return {
    ...record,
    chat: { ...record.chat, memberIds: record.chat.memberIds.filter((memberId) => memberId !== wispId) },
    sessions,
    updatedAt,
  };
}

function withConversation(
  records: WorkspaceRecords,
  conversationId: string,
  record: ConversationRecord,
): WorkspaceActionResult {
  return {
    records: { ...records, conversations: { ...records.conversations, [conversationId]: record } },
    status: "applied",
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workspace action: ${JSON.stringify(value)}`);
}
