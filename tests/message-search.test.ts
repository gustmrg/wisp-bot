import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import { buildSnippet, MESSAGE_SEARCH_LIMIT, quotePhrase } from "../backend/message-search.js";
import type { Chat, Message } from "../shared/conversations.js";
import { messageSearchText } from "../shared/message-search.js";

function chat(id: string, messages: Message[] = []): Chat {
  return {
    id,
    kind: "wisp",
    shape: "circle",
    name: id,
    label: "",
    description: "",
    notifyOnUpdatesEnabled: true,
    preview: "",
    timestamp: "Now",
    messages,
  };
}

const repositories: ConversationRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

async function repositoryWith(chats: Record<string, Chat>): Promise<ConversationRepository> {
  const repository = new ConversationRepository({
    dataDirectory: await mkdtemp(path.join(os.tmpdir(), "wisp-search-")),
  });
  repositories.push(repository);
  await repository.load();
  await repository.initialize(chats);
  return repository;
}

describe("message search", () => {
  it("matches substrings regardless of case and accents, across message types", async () => {
    const repository = await repositoryWith({
      one: chat("one", [
        { id: "text", type: "incoming", text: "The orçamento for Q3 is ready" },
        { id: "card", type: "card", items: [{ label: "Cluster", text: "Kubernetes prod" }] },
        { id: "prompt", type: "prompt", question: "Deploy now?", options: [{ key: "y", label: "Yes please" }] },
        { id: "divider", type: "time", text: "Context summarized" },
      ]),
    });

    const found = async (query: string) => (await repository.searchMessages(query)).map(({ messageId }) => messageId);

    expect(await found("ORCAMENTO")).toEqual(["text"]);
    expect(await found("bern")).toEqual(["card"]);
    expect(await found("please")).toEqual(["prompt"]);
    expect(await found("summarized")).toEqual([]);
  });

  it("returns the newest matches first, capped, and follows edits and deletions", async () => {
    const many = Array.from(
      { length: MESSAGE_SEARCH_LIMIT + 10 },
      (_, index): Message => ({
        id: `m${index}`,
        type: "incoming",
        text: `status report ${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
      }),
    );
    const repository = await repositoryWith({
      one: chat("one", many),
      two: chat("two", [{ id: "x", type: "incoming", text: "status" }]),
    });

    const hits = await repository.searchMessages("status");
    expect(hits).toHaveLength(MESSAGE_SEARCH_LIMIT);
    expect(hits[0]).toMatchObject({ conversationId: "two", messageId: "x" });
    expect(hits[1]).toMatchObject({
      conversationId: "one",
      messageId: `m${many.length - 1}`,
      createdAt: many.at(-1)?.createdAt,
    });

    await repository.appendMessage("two", { id: "x", type: "incoming", text: "rewritten" });
    await repository.deleteWisp("one");
    expect(await repository.searchMessages("status")).toEqual([]);
    expect((await repository.searchMessages("rewritten")).map(({ messageId }) => messageId)).toEqual(["x"]);
  });

  it("treats search syntax in the query as literal text", async () => {
    const repository = await repositoryWith({
      one: chat("one", [{ id: "a", type: "incoming", text: 'He said "cats OR dogs*" twice' }]),
    });

    for (const query of ['"cats OR dogs*"', "OR dogs", "dogs*", "NEAR(cats dogs)", '"unbalanced']) {
      await expect(repository.searchMessages(query)).resolves.toBeDefined();
    }
    expect((await repository.searchMessages("cats OR dogs")).map(({ messageId }) => messageId)).toEqual(["a"]);
    expect(await repository.searchMessages("cats dogs")).toEqual([]);
  });
});

describe("buildSnippet", () => {
  const long = `${"a".repeat(100)} Orçamento anual ${"b".repeat(100)}`;

  it("centers the excerpt on the match, compared like the index", () => {
    const snippet = buildSnippet({ type: "incoming", text: long }, "ORCAMENTO");

    expect(snippet).toContain("Orçamento anual");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(long.length);
  });

  it("uses the fragment that matched and collapses whitespace", () => {
    const message: Message = {
      type: "card",
      items: [
        { label: "First", text: "nothing here" },
        { label: "Second", text: "needle\n\nin   a haystack" },
      ],
    };

    expect(buildSnippet(message, "needle")).toBe("Second — needle in a haystack");
  });

  it("falls back to the opening text when the match cannot be located", () => {
    expect(buildSnippet({ type: "incoming", text: "Short text" }, "zzz")).toBe("Short text");
  });

  it("quotes queries as one literal phrase", () => {
    expect(quotePhrase('  say "hi" OR * ')).toBe('"say ""hi"" OR *"');
  });
});

describe("messageSearchText", () => {
  it("covers the text of messages, cards, and prompts, and leaves time separators out", () => {
    expect(messageSearchText({ type: "incoming", text: "Incoming project update" })).toBe("Incoming project update");
    expect(messageSearchText({ type: "outgoing", text: "Outgoing review request" })).toBe("Outgoing review request");
    expect(
      messageSearchText({
        type: "card",
        items: [
          { label: "Build", text: "Passed" },
          { label: "Coverage", text: "Ninety percent" },
        ],
      }),
    ).toBe("Build — Passed Coverage — Ninety percent");
    expect(
      messageSearchText({
        type: "prompt",
        question: "Which environment should deploy?",
        options: [
          { key: "A", label: "Staging" },
          { key: "B", label: "Production" },
        ],
        answer: "Staging",
      }),
    ).toBe("Which environment should deploy? A Staging B Production Staging");
    expect(messageSearchText({ type: "time", text: "Yesterday" })).toBe("");
  });
});
