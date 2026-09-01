import { describe, expect, it } from "vitest";

import type { Message } from "@/chat-data";
import { findMessageSearchMatch, messageSearchText } from "@/lib/message-search";

const messages = {
  incoming: { type: "incoming", text: "Incoming project update" },
  outgoing: { type: "outgoing", text: "Outgoing review request" },
  card: {
    type: "card",
    items: [
      { label: "Build", text: "Passed" },
      { label: "Coverage", text: "Ninety percent" },
    ],
  },
  prompt: {
    type: "prompt",
    question: "Which environment should deploy?",
    options: [
      { key: "A", label: "Staging" },
      { key: "B", label: "Production" },
    ],
    answer: "Staging",
  },
  time: { type: "time", text: "Yesterday" },
} satisfies Record<string, Message>;

describe("messageSearchText", () => {
  it("indexes incoming and outgoing text", () => {
    expect(messageSearchText(messages.incoming)).toBe("Incoming project update");
    expect(messageSearchText(messages.outgoing)).toBe("Outgoing review request");
  });

  it("indexes card labels and values", () => {
    expect(messageSearchText(messages.card)).toContain("Build — Passed");
    expect(messageSearchText(messages.card)).toContain("Coverage — Ninety percent");
  });

  it("indexes prompt question, options, and answer", () => {
    const text = messageSearchText(messages.prompt);

    expect(text).toContain("Which environment should deploy?");
    expect(text).toContain("A Staging");
    expect(text).toContain("B Production");
    expect(text).toContain("Staging");
  });

  it("intentionally excludes time separators", () => {
    expect(messageSearchText(messages.time)).toBe("");
    expect(findMessageSearchMatch([messages.time], "Yesterday")).toBeUndefined();
  });
});

describe("findMessageSearchMatch", () => {
  it.each([
    ["project update", messages.incoming, "Incoming project update"],
    ["review request", messages.outgoing, "Outgoing review request"],
    ["coverage", messages.card, "Coverage — Ninety percent"],
    ["production", messages.prompt, "B Production"],
    ["WHICH ENVIRONMENT", messages.prompt, "Which environment should deploy?"],
  ])("returns the matching message and relevant snippet for %s", (query, message, snippet) => {
    expect(findMessageSearchMatch([message], query)).toEqual({ message, snippet });
  });

  it("returns no match for an empty or absent query", () => {
    expect(findMessageSearchMatch(Object.values(messages), " ")).toBeUndefined();
    expect(findMessageSearchMatch(Object.values(messages), "missing")).toBeUndefined();
  });
});
