import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import type { Message } from "../shared/conversations.js";
import { seedConversations } from "./helpers/seed-conversations.js";

const LIMIT = 3;

/** A small limit: filling a conversation up to the real one takes seconds, spent only on setting up the test. */
vi.mock("../backend/storage-policy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../backend/storage-policy.js")>();
  return {
    ...original,
    CONVERSATION_STORAGE_POLICY: { ...original.CONVERSATION_STORAGE_POLICY, maxMessagesPerConversation: 3 },
  };
});

it("keeps the newest messages when a conversation reaches its limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-limit-"));
  const full: Message[] = Array.from({ length: LIMIT }, (_, index) => ({
    id: `m${index}`,
    type: "incoming",
    text: `Message ${index}`,
  }));
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
      messages: full,
    },
  });

  await repository.appendMessage("first", { id: "newest", type: "outgoing", text: "Still sends" });

  const reloaded = new ConversationRepository({ dataDirectory: directory });
  await reloaded.load();
  for (const current of [repository, reloaded]) {
    expect(current.getChats().first!.messages.map(({ id }) => id)).toEqual(["m1", "m2", "newest"]);
  }
});
