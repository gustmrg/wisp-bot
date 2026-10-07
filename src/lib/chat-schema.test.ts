import { describe, expect, it } from "vitest";

import type { ChatSummary, CircleChat, WispChat } from "@/chat-data";
import { chatName, chatViews, getDefaultChatId, isCircle, isWisp } from "@/lib/chat-schema";
import { circleChatView, testWisp, wispChatView } from "@/test/chat-fixtures";

describe("chat schema", () => {
  it("narrows variants and names each by its Wisp or its own name", () => {
    const wisp = wispChatView("atlas", { wisp: { name: "Atlas" } });
    const circle = circleChatView("crew", [wisp.wisp], { name: "Crew" });
    expect(isWisp(wisp)).toBe(true);
    expect(isCircle(circle)).toBe(true);
    expect(chatName(wisp)).toBe("Atlas");
    expect(chatName(circle)).toBe("Crew");
    expect(getDefaultChatId({ crew: circle, atlas: wisp })).toBe("crew");
    expect(getDefaultChatId({})).toBe("");
  });

  it("joins conversations with their Wisps and drops what no longer exists", () => {
    const atlas = testWisp("atlas");
    const chats: Record<string, ChatSummary> = {
      atlas: { id: "atlas", kind: "wisp", wispId: "atlas", notifyOnUpdatesEnabled: true, preview: "" },
      ghost: { id: "ghost", kind: "wisp", wispId: "ghost", notifyOnUpdatesEnabled: true, preview: "" },
      crew: {
        id: "crew",
        kind: "circle",
        name: "Crew",
        label: "",
        description: "",
        memberIds: ["atlas", "ghost", "atlas"],
        notifyOnUpdatesEnabled: true,
        preview: "",
      },
    };
    const views = chatViews(chats, { atlas });
    expect(Object.keys(views)).toEqual(["atlas", "crew"]);
    expect(views.atlas).toMatchObject({ kind: "wisp", wisp: atlas });
    expect(views.crew).toMatchObject({ kind: "circle", members: [atlas] });
  });

  it("makes mixed variant fields compile-time errors", () => {
    const wisp: WispChat = {
      id: "a",
      kind: "wisp",
      wispId: "a",
      notifyOnUpdatesEnabled: true,
      preview: "",
      messages: [],
    };
    // @ts-expect-error Wisps' conversations cannot carry circle membership.
    const invalidWisp: WispChat = { ...wisp, memberIds: [] };
    // @ts-expect-error Circles cannot carry a single Wisp.
    const invalidCircle: CircleChat = { ...circleChatView("c", []), messages: [], wispId: "a" };
    expect(invalidWisp).toBeDefined();
    expect(invalidCircle).toBeDefined();
  });
});
