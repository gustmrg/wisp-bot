import { describe, expect, it } from "vitest";

import type { Chat } from "../shared/conversations.js";
import {
  applyWorkspaceAction,
  type ConversationRecord,
  type WorkspaceRecords,
} from "../electron/backend/workspace-actions.js";

function wisp(id: string, overrides: Partial<Chat> = {}): Chat {
  return {
    id,
    kind: "wisp",
    name: "Same display name",
    label: "Test",
    description: "Test",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
    ...overrides,
  } as Chat;
}

function circle(id: string, memberIds: string[]): Chat {
  return {
    id,
    kind: "circle",
    name: id,
    label: "Circle",
    description: "Test",
    memberIds,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

function record(chat: Chat): ConversationRecord {
  return {
    chat,
    sessionId: chat.kind === "wisp" ? `session-${chat.id}` : null,
    piSessionId: null,
    piSessionFile: null,
    createdAt: "created",
    updatedAt: "before",
  };
}

describe("workspace actions", () => {
  it("creates and updates records without mutating the prior graph", () => {
    const before: WorkspaceRecords = { first: record(wisp("first")) };
    const created = applyWorkspaceAction(before, { type: "create", record: record(wisp("second")) });
    expect(created.status).toBe("applied");
    expect(before).not.toHaveProperty("second");
    const updated = applyWorkspaceAction(created.records, {
      type: "update",
      conversationId: "second",
      changes: { kind: "wisp", name: "Renamed" },
      updatedAt: "after",
    });
    expect(updated.records.second).toMatchObject({ chat: { name: "Renamed" }, updatedAt: "after" });
  });

  it("rejects duplicate creation and cross-kind updates", () => {
    const records = { first: record(wisp("first")) };
    expect(applyWorkspaceAction(records, { type: "create", record: record(wisp("first")) }).status).toBe(
      "already_exists",
    );
    expect(
      applyWorkspaceAction(records, {
        type: "update",
        conversationId: "first",
        changes: { kind: "circle", memberIds: [] },
        updatedAt: "after",
      }).status,
    ).toBe("kind_mismatch");
  });

  it("deletes a member and prunes every duplicate reference without changing order", () => {
    const records = {
      first: record(wisp("first")),
      second: record(wisp("second")),
      crew: record(circle("crew", ["second", "first", "first", "second"])),
    };
    const result = applyWorkspaceAction(records, { type: "delete", conversationId: "first", updatedAt: "after" });
    expect(result.status).toBe("applied");
    expect(result.records).not.toHaveProperty("first");
    expect(result.records.crew?.chat).toMatchObject({ memberIds: ["second", "second"] });
    expect(records.crew?.chat).toMatchObject({ memberIds: ["second", "first", "first", "second"] });
  });

  it("replaces circle membership atomically, deduplicates IDs, and preserves selected order", () => {
    const records = {
      first: record(wisp("first")),
      second: record(wisp("second")),
      crew: record(circle("crew", ["first"])),
    };
    const result = applyWorkspaceAction(records, {
      type: "replace-circle-members",
      conversationId: "crew",
      memberIds: ["second", "first", "second"],
      updatedAt: "after",
    });

    expect(result.status).toBe("applied");
    expect(result.records.crew?.chat).toMatchObject({ memberIds: ["second", "first"] });
    expect(records.crew?.chat).toMatchObject({ memberIds: ["first"] });
  });

  it("rejects missing, circle, and non-circle membership targets", () => {
    const records = { first: record(wisp("first")), crew: record(circle("crew", [])) };
    for (const memberIds of [["missing"], ["crew"]]) {
      const result = applyWorkspaceAction(records, {
        type: "replace-circle-members",
        conversationId: "crew",
        memberIds,
        updatedAt: "after",
      });
      expect(result).toEqual({ records, status: "invalid_member" });
    }
    expect(
      applyWorkspaceAction(records, {
        type: "replace-circle-members",
        conversationId: "first",
        memberIds: [],
        updatedAt: "after",
      }).status,
    ).toBe("kind_mismatch");
  });

  it("deletes circles and supports an empty result", () => {
    const onlyCircle = { crew: record(circle("crew", [])) };
    const result = applyWorkspaceAction(onlyCircle, {
      type: "delete",
      conversationId: "crew",
      updatedAt: "after",
    });
    expect(result.status).toBe("applied");
    expect(result.records).toEqual({});
  });

  it("rejects deletion of metadata-protected records", () => {
    const records = { leader: record(wisp("leader", { systemRole: "chief" })) };
    const result = applyWorkspaceAction(records, {
      type: "delete",
      conversationId: "leader",
      updatedAt: "after",
    });
    expect(result.status).toBe("protected");
    expect(result.records).toBe(records);
  });

  it("marks unread records and leaves already-read or missing targets unchanged", () => {
    const records = { first: record(wisp("first", { unread: true })) };
    const marked = applyWorkspaceAction(records, {
      type: "mark-read",
      conversationId: "first",
      updatedAt: "after",
    });
    expect(marked.records.first?.chat.unread).toBe(false);
    expect(
      applyWorkspaceAction(marked.records, {
        type: "mark-read",
        conversationId: "first",
        updatedAt: "later",
      }).status,
    ).toBe("unchanged");
    expect(
      applyWorkspaceAction(records, { type: "mark-read", conversationId: "missing", updatedAt: "after" }).status,
    ).toBe("not_found");
  });

  it("upserts messages and treats a missing target as a no-op", () => {
    const records = { first: record(wisp("first")) };
    const appended = applyWorkspaceAction(records, {
      type: "append-message",
      conversationId: "first",
      message: { id: "message-1", type: "incoming", text: "Hello" },
      updatedAt: "after",
    });
    const replaced = applyWorkspaceAction(appended.records, {
      type: "append-message",
      conversationId: "first",
      message: { id: "message-1", type: "incoming", text: "Complete" },
      updatedAt: "later",
    });
    expect(replaced.records.first?.chat.messages).toEqual([
      expect.objectContaining({ id: "message-1", text: "Complete" }),
    ]);
    const missing = applyWorkspaceAction(records, {
      type: "append-message",
      conversationId: "missing",
      message: { id: "message-1", type: "incoming", text: "Ignored" },
      updatedAt: "after",
    });
    expect(missing).toEqual({ records, status: "not_found" });
  });

  it("answers an existing prompt and reports a missing prompt", () => {
    const records = {
      first: record(
        wisp("first", {
          messages: [{ id: "prompt-1", type: "prompt", question: "Continue?", options: [] }],
        }),
      ),
    };
    const answered = applyWorkspaceAction(records, {
      type: "answer-prompt",
      conversationId: "first",
      messageId: "prompt-1",
      answer: "yes",
      updatedAt: "after",
    });
    expect(answered.records.first?.chat.messages[0]).toMatchObject({ answer: "yes" });
    expect(
      applyWorkspaceAction(records, {
        type: "answer-prompt",
        conversationId: "first",
        messageId: "missing",
        answer: "yes",
        updatedAt: "after",
      }).status,
    ).toBe("prompt_not_found");
  });

  it("does not link a replacement Wisp with the same display name to an old circle", () => {
    const old = record(wisp("opaque-old"));
    const initial = { "opaque-old": old, crew: record(circle("crew", ["opaque-old"])) };
    const deleted = applyWorkspaceAction(initial, {
      type: "delete",
      conversationId: "opaque-old",
      updatedAt: "after-delete",
    });
    const recreated = applyWorkspaceAction(deleted.records, {
      type: "create",
      record: record(wisp("opaque-new")),
    });
    expect(recreated.records["opaque-new"]?.chat.name).toBe(old.chat.name);
    expect(recreated.records.crew?.chat).toMatchObject({ memberIds: [] });
  });
});
