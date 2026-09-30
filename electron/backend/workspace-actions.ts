import type { ModelSelection } from "../../shared/contracts.js";
import type { Chat, ChatChanges, Message } from "../../shared/conversations.js";
import { normalizeChat, upsertNormalizedMessage } from "./conversation-normalizer.js";

export interface ConversationRecord {
  chat: Chat;
  sessionId: string | null;
  piSessionId: string | null;
  modelOverride?: ModelSelection | null;
  piSessionFile: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRecords = Record<string, ConversationRecord>;

export type WorkspaceAction =
  | { type: "create"; record: ConversationRecord }
  | { type: "update"; conversationId: string; changes: ChatChanges; updatedAt: string }
  | { type: "replace-circle-members"; conversationId: string; memberIds: ReadonlyArray<string>; updatedAt: string }
  | { type: "delete"; conversationId: string; updatedAt: string }
  | { type: "mark-read"; conversationId: string; updatedAt: string }
  | { type: "append-message"; conversationId: string; message: Message & { id: string }; updatedAt: string }
  | { type: "answer-prompt"; conversationId: string; messageId: string; answer: string; updatedAt: string };

export type WorkspaceActionStatus =
  | "applied"
  | "unchanged"
  | "not_found"
  | "already_exists"
  | "kind_mismatch"
  | "invalid_member"
  | "protected"
  | "prompt_not_found";

export interface WorkspaceActionResult {
  records: WorkspaceRecords;
  status: WorkspaceActionStatus;
  deletedRecord?: ConversationRecord;
  /** Oldest messages an append dropped to stay within the per-conversation limit. */
  droppedOldestMessages?: number;
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

/**
 * The chat's last activity: its newest timestamped message, else its own ISO
 * timestamp, else unknown. Mirrors the migration backfill in
 * `conversation-store.ts`.
 */
export function lastActivityOf(chat: Pick<Chat, "messages" | "timestamp">): string | undefined {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const createdAt = chat.messages[index]?.createdAt;
    if (createdAt) return createdAt;
  }
  return ISO_TIMESTAMP_PATTERN.test(chat.timestamp) ? chat.timestamp : undefined;
}

/** A chat with its derived last activity, replacing any value it arrived with. */
export function withLastActivity<T extends Chat>(chat: T): T {
  const { lastActivityAt: _ignored, ...rest } = chat;
  const lastActivityAt = lastActivityOf(chat);
  return (lastActivityAt ? { ...rest, lastActivityAt } : rest) as T;
}

// Later of two ISO times. Writes can arrive out of order (a delivery status
// update after a newer message), so activity never moves backwards.
function laterOf(current: string | undefined, candidate: string): string {
  return current && Date.parse(current) >= Date.parse(candidate) ? current : candidate;
}

export function applyWorkspaceAction(records: WorkspaceRecords, action: WorkspaceAction): WorkspaceActionResult {
  switch (action.type) {
    case "create": {
      const id = action.record.chat.id;
      if (records[id]) return { records, status: "already_exists" };
      return { records: { ...records, [id]: action.record }, status: "applied" };
    }
    case "update": {
      const record = records[action.conversationId];
      if (!record) return { records, status: "not_found" };
      const { kind, ...fields } = action.changes;
      if (record.chat.kind !== kind) return { records, status: "kind_mismatch" };
      const chat = normalizeChat({ ...record.chat, ...fields });
      return replaceRecord(records, action.conversationId, { ...record, chat, updatedAt: action.updatedAt });
    }
    case "replace-circle-members": {
      const record = records[action.conversationId];
      if (!record) return { records, status: "not_found" };
      if (record.chat.kind !== "circle") return { records, status: "kind_mismatch" };
      const memberIds = [...new Set(action.memberIds)];
      if (memberIds.some((memberId) => records[memberId]?.chat.kind !== "wisp")) {
        return { records, status: "invalid_member" };
      }
      return replaceRecord(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, memberIds },
        updatedAt: action.updatedAt,
      });
    }
    case "delete": {
      const deletedRecord = records[action.conversationId];
      if (!deletedRecord) return { records, status: "not_found" };
      if (deletedRecord.chat.systemRole) return { records, status: "protected" };
      const next = Object.fromEntries(
        Object.entries(records).flatMap(([id, record]) => {
          if (id === action.conversationId) return [];
          if (record.chat.kind !== "circle" || !record.chat.memberIds.includes(action.conversationId)) {
            return [[id, record]];
          }
          return [
            [
              id,
              {
                ...record,
                chat: {
                  ...record.chat,
                  memberIds: record.chat.memberIds.filter((memberId) => memberId !== action.conversationId),
                },
                updatedAt: action.updatedAt,
              },
            ],
          ];
        }),
      );
      return { records: next, status: "applied", deletedRecord };
    }
    case "mark-read": {
      const record = records[action.conversationId];
      if (!record) return { records, status: "not_found" };
      if (!record.chat.unread) return { records, status: "unchanged" };
      return replaceRecord(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, unread: false },
        updatedAt: action.updatedAt,
      });
    }
    case "append-message": {
      const record = records[action.conversationId];
      if (!record) return { records, status: "not_found" };
      const { chat, message, droppedOldest } = upsertNormalizedMessage(record.chat, action.message);
      return {
        ...replaceRecord(records, action.conversationId, {
          ...record,
          chat: {
            ...chat,
            preview: "text" in message ? message.text : chat.preview,
            timestamp: action.updatedAt,
            lastActivityAt: laterOf(chat.lastActivityAt, message.createdAt ?? action.updatedAt),
          },
          updatedAt: action.updatedAt,
        }),
        droppedOldestMessages: droppedOldest,
      };
    }
    case "answer-prompt": {
      const record = records[action.conversationId];
      if (!record) return { records, status: "not_found" };
      let found = false;
      const messages = record.chat.messages.map((message) => {
        if (message.id !== action.messageId || message.type !== "prompt") return message;
        found = true;
        return { ...message, answer: action.answer };
      });
      if (!found) return { records, status: "prompt_not_found" };
      return replaceRecord(records, action.conversationId, {
        ...record,
        chat: { ...record.chat, messages },
        updatedAt: action.updatedAt,
      });
    }
    default:
      return assertNever(action);
  }
}

function replaceRecord(
  records: WorkspaceRecords,
  conversationId: string,
  record: ConversationRecord,
): WorkspaceActionResult {
  return { records: { ...records, [conversationId]: record }, status: "applied" };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workspace action: ${JSON.stringify(value)}`);
}
