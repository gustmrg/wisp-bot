import { describe, expect, it } from "vitest";

import type { Chat, CircleChat, WispChat } from "@/chat-data";
import { canDeleteChat, getDefaultChatId, isCircle, isWisp } from "@/lib/chat-schema";

const wisp: WispChat = {
  id: "wisp-1",
  kind: "wisp",
  name: "Wisp",
  label: "Test",
  description: "Test Wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

const circle: CircleChat = {
  id: "circle-1",
  kind: "circle",
  name: "Circle",
  label: "Test",
  description: "Test circle",
  memberIds: [wisp.id],
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
};

describe("chat schema", () => {
  it("narrows variants and selects the metadata-defined chief", () => {
    const chats: Record<string, Chat> = {
      first: circle,
      leader: { ...wisp, id: "leader", systemRole: "chief" },
    };
    expect(isWisp(chats.leader as Chat)).toBe(true);
    expect(isCircle(chats.first as Chat)).toBe(true);
    expect(getDefaultChatId(chats)).toBe("leader");
    expect(canDeleteChat(chats.leader as Chat)).toBe(false);
    expect(canDeleteChat(circle)).toBe(true);
  });

  it("makes mixed variant fields compile-time errors", () => {
    // @ts-expect-error Wisps cannot carry circle membership.
    const invalidWisp: WispChat = { ...wisp, memberIds: [] };
    // @ts-expect-error Circles cannot carry Wisp appearance.
    const invalidCircle: CircleChat = { ...circle, shape: "circle" };
    expect(invalidWisp).toBeDefined();
    expect(invalidCircle).toBeDefined();
  });
});
