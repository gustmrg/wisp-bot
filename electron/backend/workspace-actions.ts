import type { Chat, ChatChanges, Message } from "../../shared/conversations.js";
import { normalizeChat } from "./conversation-normalizer.js";

export interface ConversationRecord {
  chat: Chat;
  sessionId: string | null;
  piSessionId: string | null;
  piSessionFile: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRecords = Record<string, ConversationRecord>;

export type WorkspaceAction =
  | { type: "create"; record: ConversationRecord }
  | { type: "update"; conversationId: string; changes: ChatChanges; updatedAt: string }
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
  | "protected"
  | "prompt_not_found";

export interface WorkspaceActionResult {
  records: WorkspaceRecords;
  status: WorkspaceActionStatus;
  deletedRecord?: ConversationRecord;
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
      const existingIndex = record.chat.messages.findIndex(({ id }) => id === action.message.id);
      const messages =
        existingIndex === -1
          ? [...record.chat.messages, action.message]
          : record.chat.messages.map((message, index) => (index === existingIndex ? action.message : message));
      const normalized = normalizeChat({ ...record.chat, messages });
      const current = normalized.messages.find(({ id }) => id === action.message.id);
      return replaceRecord(records, action.conversationId, {
        ...record,
        chat: {
          ...normalized,
          preview: current && "text" in current ? current.text : normalized.preview,
          timestamp: "Now",
        },
        updatedAt: action.updatedAt,
      });
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
