import type { ConversationRepository } from "../../backend/conversation-repository.js";
import type { Message } from "../../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

/**
 * A conversation to start a test with: a Wisp's (`kind: "wisp"`, its name, label
 * and description becoming the Wisp's name, role and soul) or a circle's, with
 * the messages it already holds.
 */
export type SeedChat = Record<string, unknown> & { kind: "wisp" | "circle"; messages?: ReadonlyArray<unknown> };

/**
 * Sets up a new store and creates each conversation through the repository, as
 * the app would: Wisps first, so circles can name them as members, then each
 * conversation's messages in order. A Wisp's conversation shares its key.
 */
export async function seedConversations(
  repository: ConversationRepository,
  chats: Readonly<Record<string, SeedChat>>,
): Promise<void> {
  await repository.initialize();
  const entries = Object.entries(chats);
  for (const [id, chat] of entries) {
    if (chat.kind !== "wisp") continue;
    await repository.createWisp(
      {
        id,
        name: typeof chat.name === "string" ? chat.name : id,
        role: typeof chat.label === "string" && chat.label ? chat.label : "Test",
        soul: typeof chat.description === "string" && chat.description ? chat.description : "A test Wisp",
        appearance: chat.appearance ?? DEFAULT_WISP_APPEARANCE,
      },
      { notifyOnUpdatesEnabled: chat.notifyOnUpdatesEnabled !== false },
    );
    for (const message of chat.messages ?? []) await repository.appendMessage(id, message as Message);
  }
  for (const [id, chat] of entries) {
    if (chat.kind !== "circle") continue;
    await repository.create({
      label: "",
      description: "",
      preview: "",
      notifyOnUpdatesEnabled: true,
      memberIds: [],
      ...chat,
      id,
      messages: chat.messages ?? [],
    });
  }
}
