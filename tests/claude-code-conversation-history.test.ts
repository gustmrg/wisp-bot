import { describe, expect, it } from "vitest";

import { formatHistorySearch, recentTranscript } from "../backend/claude-code/conversation-history.js";
import type { Message, MessagePage } from "../shared/conversations.js";

const message = (type: "incoming" | "outgoing", text: string, id = text) => ({ id, type, text }) as Message;
const page = (messages: Message[]): MessagePage => ({ messages, olderCursor: null, newerCursor: null });

describe("recentTranscript", () => {
  it("writes the latest text messages oldest first, leaving out the rest", () => {
    const transcript = recentTranscript(
      page([
        message("outgoing", "What's the weather?"),
        { id: "t", type: "time", time: "Today" } as unknown as Message,
        message("incoming", "Sunny and 24°C."),
        message("incoming", "   "),
      ]),
    );

    expect(transcript).toBe("User: What's the weather?\n\nWisp: Sunny and 24°C.");
  });

  it("keeps the newest messages when the page does not fit", () => {
    const transcript = recentTranscript(
      page([message("outgoing", "old ".repeat(2_500), "a"), message("incoming", "newest", "b")]),
    );

    expect(transcript).toBe("Wisp: newest");
    expect(recentTranscript(page([message("outgoing", "x".repeat(9_000))])).length).toBe(8_000);
  });
});

describe("formatHistorySearch", () => {
  it("lists this conversation's matches, newest first", () => {
    expect(
      formatHistorySearch("c1", [
        { conversationId: "c1", messageId: "m2", snippet: "…the invoice is due Friday…", createdAt: "2026-10-18" },
        { conversationId: "c2", messageId: "m9", snippet: "another conversation" },
        { conversationId: "c1", messageId: "m1", snippet: "…invoice sent…" },
      ]),
    ).toBe("[2026-10-18] …the invoice is due Friday…\n\n…invoice sent…");
    expect(formatHistorySearch("c1", [])).toBe("No earlier messages match.");
  });
});
