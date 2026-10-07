import type { ChatSummary, CircleChatView, Wisp, WispChatView, WispSummary } from "@/chat-data";

export function testWisp(id: string, overrides: Partial<Wisp> = {}): Wisp {
  return { id, name: id, role: "Test", soul: "Test", shape: "circle", ...overrides };
}

/** A Wisp's own conversation as the app shows it. */
export function wispChatView(
  id: string,
  overrides: { wisp?: Partial<Wisp>; chat?: Partial<Omit<WispSummary, "kind" | "wispId">> } = {},
): WispChatView {
  return {
    id,
    kind: "wisp",
    wispId: id,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    ...overrides.chat,
    wisp: testWisp(id, overrides.wisp),
  };
}

export function circleChatView(
  id: string,
  members: ReadonlyArray<Wisp>,
  overrides: Partial<Omit<ChatSummary & { kind: "circle" }, "kind" | "memberIds">> = {},
): CircleChatView {
  return {
    id,
    kind: "circle",
    name: id,
    label: "Circle",
    description: "",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    memberIds: members.map(({ id: memberId }) => memberId),
    ...overrides,
    members,
  };
}
