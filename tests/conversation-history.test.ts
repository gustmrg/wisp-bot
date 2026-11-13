import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import type { Message } from "../shared/conversations.js";
import { seedConversations } from "./helpers/seed-conversations.js";

const REQUEST_LIMIT = 3;

/** A small limit: reaching the real one takes seconds, spent only on setting up the test. */
vi.mock("../backend/storage-policy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../backend/storage-policy.js")>();
  return {
    ...original,
    CONVERSATION_STORAGE_POLICY: { ...original.CONVERSATION_STORAGE_POLICY, maxMessagesPerRequest: 3 },
  };
});

function numbered(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, type: "incoming", text: `Message ${index}` }));
}

it("keeps every message of a conversation, however many one request may carry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-history-"));
  const repository = new ConversationRepository({ dataDirectory: directory });
  await seedConversations(repository, {
    first: {
      id: "first",
      kind: "wisp",
      name: "first",
      label: "Test",
      description: "A test conversation",
      notifyOnUpdatesEnabled: true,
      preview: "Ready",
      messages: numbered(REQUEST_LIMIT + 2),
    },
  });

  await repository.appendMessage("first", { id: "newest", type: "outgoing", text: "Still sends" });

  const reloaded = new ConversationRepository({ dataDirectory: directory });
  await reloaded.load();
  for (const current of [repository, reloaded]) {
    const { messages, olderCursor } = await current.getMessagePage({ conversationId: "first", page: "latest" });
    expect(messages.map(({ id }) => id)).toEqual(["m0", "m1", "m2", "m3", "m4", "newest"]);
    expect(olderCursor).toBeNull();
  }

  // One request is still bounded: a new circle may start with only so many messages.
  const circle = {
    id: "crew",
    kind: "circle",
    name: "Crew",
    label: "",
    description: "",
    notifyOnUpdatesEnabled: true,
    preview: "",
    memberIds: ["first"],
  };
  await expect(repository.create({ ...circle, messages: numbered(REQUEST_LIMIT + 1) })).rejects.toMatchObject({
    code: "invalid_request",
  });
  await expect(repository.create({ ...circle, messages: numbered(REQUEST_LIMIT) })).resolves.toBeUndefined();
});
