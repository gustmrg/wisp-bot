import { describe, expect, it } from "vitest";

import type { Chat, CircleChat, WispChat } from "../shared/conversations.js";
import {
  applyWorkspaceAction,
  type ConversationRecord,
  type WispRecord,
  type WorkspaceRecords,
} from "../backend/workspace-actions.js";

function wispRecord(id: string): WispRecord {
  return {
    wisp: { id, name: "Same display name", role: "Test", soul: "Test", shape: "circle" },
    storageId: `storage-${id}`,
    modelOverride: null,
    createdAt: "created",
    updatedAt: "before",
  };
}

function wispChat(id: string, overrides: Partial<WispChat> = {}): WispChat {
  return { id, kind: "wisp", wispId: id, notifyOnUpdatesEnabled: true, preview: "Ready", messages: [], ...overrides };
}

function circle(id: string, memberIds: string[]): CircleChat {
  return {
    id,
    kind: "circle",
    name: id,
    label: "Circle",
    description: "Test",
    memberIds,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    messages: [],
  };
}

function record(chat: Chat): ConversationRecord {
  return {
    chat,
    storageId: `workspace-${chat.id}`,
    sessions:
      chat.kind === "wisp"
        ? { [chat.wispId]: { sessionId: `session-${chat.id}`, piSessionId: null, piSessionFile: null } }
        : {},
    createdAt: "created",
    updatedAt: "before",
  };
}

/** Wisps with their own conversations, and the given circles. */
function graph(wispIds: string[], circles: CircleChat[] = []): WorkspaceRecords {
  return {
    wisps: Object.fromEntries(wispIds.map((id) => [id, wispRecord(id)])),
    conversations: Object.fromEntries([
      ...wispIds.map((id) => [id, record(wispChat(id))] as const),
      ...circles.map((chat) => [chat.id, record(chat)] as const),
    ]),
  };
}

describe("workspace actions", () => {
  it("creates a Wisp with its own conversation without mutating the prior graph", () => {
    const before = graph(["first"]);
    const created = applyWorkspaceAction(before, {
      type: "create-wisp",
      wisp: wispRecord("second"),
      conversation: record(wispChat("second")),
    });
    expect(created.status).toBe("applied");
    expect(created.records.wisps.second?.wisp.id).toBe("second");
    expect(created.records.conversations.second?.chat).toMatchObject({ kind: "wisp", wispId: "second" });
    expect(before.wisps).not.toHaveProperty("second");
    expect(before.conversations).not.toHaveProperty("second");
  });

  it("updates the Wisp itself and clears an optional field set to undefined", () => {
    const records = graph(["first"]);
    const colored = applyWorkspaceAction(records, {
      type: "update-wisp",
      wispId: "first",
      changes: { name: "Renamed", soul: "# Identity\nCareful", color: "#fff" },
      updatedAt: "after",
    });
    expect(colored.records.wisps.first).toMatchObject({
      wisp: { name: "Renamed", soul: "# Identity\nCareful", color: "#fff" },
      updatedAt: "after",
    });
    expect(colored.records.conversations).toBe(records.conversations);
    const cleared = applyWorkspaceAction(colored.records, {
      type: "update-wisp",
      wispId: "first",
      changes: { color: undefined },
      updatedAt: "later",
    });
    expect(cleared.records.wisps.first?.wisp).not.toHaveProperty("color");
    expect(
      applyWorkspaceAction(records, { type: "update-wisp", wispId: "missing", changes: {}, updatedAt: "x" }).status,
    ).toBe("not_found");
  });

  it("rejects duplicate creation and cross-kind updates", () => {
    const records = graph(["first"]);
    expect(
      applyWorkspaceAction(records, {
        type: "create-wisp",
        wisp: wispRecord("first"),
        conversation: record(wispChat("first")),
      }).status,
    ).toBe("already_exists");
    expect(applyWorkspaceAction(records, { type: "create", record: record(circle("first", [])) }).status).toBe(
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

  it("deletes a Wisp with its conversation and prunes every duplicate reference without changing order", () => {
    const records = graph(["first", "second"], [circle("crew", ["second", "first", "first", "second"])]);
    const result = applyWorkspaceAction(records, { type: "delete-wisp", wispId: "first", updatedAt: "after" });
    expect(result.status).toBe("applied");
    expect(result.records.wisps).not.toHaveProperty("first");
    expect(result.records.conversations).not.toHaveProperty("first");
    expect(result.deleted).toEqual({ wisp: records.wisps.first, conversation: records.conversations.first });
    expect(result.records.conversations.crew?.chat).toMatchObject({ memberIds: ["second", "second"] });
    expect(records.conversations.crew?.chat).toMatchObject({ memberIds: ["second", "first", "first", "second"] });
  });

  it("deletes a Wisp's conversation only with the Wisp", () => {
    const records = graph(["first"]);
    expect(applyWorkspaceAction(records, { type: "delete", conversationId: "first", updatedAt: "after" }).status).toBe(
      "kind_mismatch",
    );
  });

  it("replaces circle membership atomically, deduplicates IDs, and preserves selected order", () => {
    const records = graph(["first", "second"], [circle("crew", ["first"])]);
    const result = applyWorkspaceAction(records, {
      type: "replace-circle-members",
      conversationId: "crew",
      memberIds: ["second", "first", "second"],
      updatedAt: "after",
    });

    expect(result.status).toBe("applied");
    expect(result.records.conversations.crew?.chat).toMatchObject({ memberIds: ["second", "first"] });
    expect(records.conversations.crew?.chat).toMatchObject({ memberIds: ["first"] });
  });

  it("rejects missing, circle, and non-circle membership targets", () => {
    const records = graph(["first"], [circle("crew", [])]);
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
    const onlyCircle = graph([], [circle("crew", [])]);
    const result = applyWorkspaceAction(onlyCircle, {
      type: "delete",
      conversationId: "crew",
      updatedAt: "after",
    });
    expect(result.status).toBe("applied");
    expect(result.records).toEqual({ wisps: {}, conversations: {} });
  });

  it("marks unread records and leaves already-read or missing targets unchanged", () => {
    const records: WorkspaceRecords = {
      ...graph(["first"]),
      conversations: { first: record(wispChat("first", { unread: true })) },
    };
    const marked = applyWorkspaceAction(records, {
      type: "mark-read",
      conversationId: "first",
      updatedAt: "after",
    });
    expect(marked.records.conversations.first?.chat.unread).toBe(false);
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
    const records = graph(["first"]);
    const appended = applyWorkspaceAction(records, {
      type: "append-message",
      conversationId: "first",
      message: { id: "message-1", type: "incoming", text: "Hello", authorId: "first" },
      updatedAt: "after",
    });
    const replaced = applyWorkspaceAction(appended.records, {
      type: "append-message",
      conversationId: "first",
      message: { id: "message-1", type: "incoming", text: "Complete", authorId: "first" },
      updatedAt: "later",
    });
    expect(replaced.records.conversations.first?.chat.messages).toEqual([
      expect.objectContaining({ id: "message-1", text: "Complete", authorId: "first" }),
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
    const records: WorkspaceRecords = {
      ...graph(["first"]),
      conversations: {
        first: record(
          wispChat("first", { messages: [{ id: "prompt-1", type: "prompt", question: "Continue?", options: [] }] }),
        ),
      },
    };
    const answered = applyWorkspaceAction(records, {
      type: "answer-prompt",
      conversationId: "first",
      messageId: "prompt-1",
      answer: "yes",
      updatedAt: "after",
    });
    expect(answered.records.conversations.first?.chat.messages[0]).toMatchObject({ answer: "yes" });
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
    const initial = graph(["opaque-old"], [circle("crew", ["opaque-old"])]);
    const deleted = applyWorkspaceAction(initial, {
      type: "delete-wisp",
      wispId: "opaque-old",
      updatedAt: "after-delete",
    });
    const recreated = applyWorkspaceAction(deleted.records, {
      type: "create-wisp",
      wisp: wispRecord("opaque-new"),
      conversation: record(wispChat("opaque-new")),
    });
    expect(recreated.records.wisps["opaque-new"]?.wisp.name).toBe(initial.wisps["opaque-old"]?.wisp.name);
    expect(recreated.records.conversations.crew?.chat).toMatchObject({ memberIds: [] });
  });
});
