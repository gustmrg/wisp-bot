import { afterEach, describe, expect, it, vi } from "vitest";

import { GMAIL_SCOPES, decodeEncodedWords, gmail, htmlToText, rawMessage } from "../backend/plugins/gmail.js";
import { getToolMetadata } from "../shared/tool-catalog.js";

const TOKEN = "access-token-must-not-appear";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const tool = (name: string) => {
  const found = gmail.tools.find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
};
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** Answers Gmail's API by URL; every request is recorded. No network is used. */
function mockGmail(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname.replace("/gmail/v1/users/me", "");
    const body = routes[path];
    return body === undefined ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The RFC 2822 message a draft request carried. */
function sentDraft(fetchMock: ReturnType<typeof mockGmail>) {
  const call = fetchMock.mock.calls.find(([url]) => new URL(url).pathname.includes("/drafts"))!;
  const body = JSON.parse(String(call[1]?.body));
  const text = Buffer.from(body.message.raw, "base64url").toString("utf8");
  const [head, encodedBody] = text.split("\r\n\r\n");
  return {
    url: new URL(call[0]),
    method: call[1]?.method,
    threadId: body.message.threadId,
    headers: head!.split("\r\n"),
    body: Buffer.from(encodedBody!.replace(/\r\n/g, ""), "base64").toString("utf8"),
  };
}

const ORIGINAL = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Can we meet?",
  payload: {
    headers: [
      { name: "From", value: "Ana <ana@example.com>" },
      { name: "Reply-To", value: "Ana Team <team@example.com>" },
      { name: "To", value: "me@example.com" },
      { name: "Subject", value: "=?UTF-8?B?UmV1bmnDo28=?=" },
      { name: "Date", value: "Mon, 19 Oct 2026 10:00:00 -0300" },
      { name: "Message-ID", value: "<abc@mail.example.com>" },
      { name: "References", value: "<root@mail.example.com>" },
    ],
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Plain version.\nSee you.") } },
          { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "agenda.pdf", body: { attachmentId: "att1", size: 1234 } },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gmail plugin", () => {
  it("reads mail and writes drafts, and has no tool that sends", () => {
    expect(gmail.oauth?.scopes).toEqual([...GMAIL_SCOPES]);
    expect(gmail.oauth?.authorizationParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(gmail.tools.map(({ name, access }) => [name, access])).toEqual([
      ["gmail_search_messages", "read"],
      ["gmail_read_message", "read"],
      ["gmail_read_thread", "read"],
      ["gmail_list_labels", "read"],
      ["gmail_list_drafts", "read"],
      ["gmail_create_draft", "write"],
      ["gmail_update_draft", "write"],
    ]);
    expect(gmail.tools.some(({ name, description }) => /send/.test(name) || /\bsends\b/.test(description))).toBe(false);
    for (const { name } of gmail.tools) expect(getToolMetadata(name)).toMatchObject({ pluginId: "gmail" });
  });

  it("searches with Gmail syntax and returns decoded headers for each message", async () => {
    const fetchMock = mockGmail({
      "/messages": { messages: [{ id: "m1" }], nextPageToken: "next" },
      "/messages/m1": ORIGINAL,
    });
    const result = JSON.parse(await tool("gmail_search_messages").execute(TOKEN, { query: "is:unread", limit: 5 }));
    const list = new URL(fetchMock.mock.calls[0]![0]);
    expect(Object.fromEntries(list.searchParams)).toEqual({ q: "is:unread", maxResults: "5" });
    const metadata = new URL(fetchMock.mock.calls[1]![0]);
    expect(metadata.searchParams.get("format")).toBe("metadata");
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({
      nextPageToken: "next",
      messages: [
        expect.objectContaining({
          id: "m1",
          threadId: "t1",
          from: "Ana <ana@example.com>",
          subject: "Reunião",
          unread: true,
        }),
      ],
    });
  });

  it("reads a message as text, preferring plain text, and lists attachments without their contents", async () => {
    mockGmail({ "/messages/m1": ORIGINAL });
    const message = JSON.parse(await tool("gmail_read_message").execute(TOKEN, { messageId: "m1" }));
    expect(message).toMatchObject({
      subject: "Reunião",
      replyTo: "Ana Team <team@example.com>",
      body: "Plain version.\nSee you.",
      attachments: [{ filename: "agenda.pdf", mimeType: "application/pdf", size: 1234 }],
      link: "https://mail.google.com/mail/u/0/#all/t1",
    });
    await expect(tool("gmail_read_message").execute(TOKEN, { messageId: "../../profile" })).rejects.toThrow(
      /Invalid messageId/,
    );
  });

  it("turns HTML-only mail into readable text without scripts", () => {
    expect(
      htmlToText(
        '<html><head><style>p{}</style></head><body><script>alert(1)</script><p>Hello&nbsp;<b>there</b></p><p><a href="https://x.example/pay">Pay</a> &amp; go</p><ul><li>One</li></ul></body></html>',
      ),
    ).toBe("Hello there\nPay (https://x.example/pay) & go\n- One");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?caf=E9_ol=E9?=")).toBe("café olé");
  });

  it("shares a thread's space between its messages", async () => {
    const long = "x".repeat(30_000);
    const message = (id: string) => ({
      ...ORIGINAL,
      id,
      payload: { headers: ORIGINAL.payload.headers, mimeType: "text/plain", body: { data: b64(long) } },
    });
    mockGmail({ "/threads/t1": { id: "t1", messages: [message("a"), message("b")] } });
    const thread = JSON.parse(await tool("gmail_read_thread").execute(TOKEN, { threadId: "t1" }));
    expect(thread.messages).toHaveLength(2);
    for (const { body } of thread.messages) {
      expect(body.length).toBeLessThan(12_100);
      expect(body).toMatch(/\[Message truncated\]$/);
    }
  });

  it("writes a new draft as plain text with safely encoded headers", async () => {
    const fetchMock = mockGmail({ "/drafts": { id: "d1", message: { id: "m9", threadId: "t9" } } });
    const result = JSON.parse(
      await tool("gmail_create_draft").execute(TOKEN, {
        to: ["ana@example.com", "ana@example.com"],
        cc: ["bob@example.com"],
        subject: "Orçamento\r\nBcc: attacker@example.com",
        body: "Olá,\nsegue o orçamento.",
      }),
    );
    const draft = sentDraft(fetchMock);
    expect(draft.method).toBe("POST");
    expect(draft.url.pathname).toBe("/gmail/v1/users/me/drafts");
    expect(draft.headers).toContain("To: ana@example.com");
    expect(draft.headers).toContain("Cc: bob@example.com");
    // The line break cannot start a header of its own.
    expect(draft.headers.filter((line) => line.startsWith("Bcc:"))).toEqual([]);
    const subject = draft.headers.find((line) => line.startsWith("Subject: "))!;
    expect(decodeEncodedWords(subject.slice(9))).toBe("Orçamento Bcc: attacker@example.com");
    expect(draft.body).toBe("Olá,\r\nsegue o orçamento.");
    expect(result).toMatchObject({ draftId: "d1", note: expect.stringContaining("not sent") });
  });

  it("drafts a reply in the original thread, to its Reply-To address, quoting its Message-ID", async () => {
    const fetchMock = mockGmail({
      "/messages/m1": ORIGINAL,
      "/drafts": { id: "d2", message: { id: "m10", threadId: "t1" } },
    });
    await tool("gmail_create_draft").execute(TOKEN, { replyToMessageId: "m1", body: "Yes, Tuesday works." });
    const draft = sentDraft(fetchMock);
    expect(draft.threadId).toBe("t1");
    expect(draft.headers).toEqual(
      expect.arrayContaining([
        "To: team@example.com",
        `Subject: ${rawSubject("Re: Reunião")}`,
        "In-Reply-To: <abc@mail.example.com>",
        "References: <root@mail.example.com> <abc@mail.example.com>",
      ]),
    );
  });

  it("rewrites a draft in place, and refuses a draft without recipients", async () => {
    const fetchMock = mockGmail({ "/drafts/d1": { id: "d1", message: { id: "m9", threadId: "t9" } } });
    await tool("gmail_update_draft").execute(TOKEN, { draftId: "d1", to: ["ana@example.com"], body: "Updated." });
    expect(sentDraft(fetchMock).method).toBe("PUT");
    await expect(tool("gmail_create_draft").execute(TOKEN, { body: "Nobody." })).rejects.toThrow(
      /at least one recipient/,
    );
    await expect(
      tool("gmail_create_draft").execute(TOKEN, { to: ["Ana <ana@example.com>"], body: "x" }),
    ).rejects.toThrow(/Invalid to/);
  });

  it("explains a refusal without leaking the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: TOKEN } }, { status: 403 })),
    );
    const failure = await tool("gmail_list_labels")
      .execute(TOKEN, {})
      .catch((error: Error) => error);
    expect(String(failure)).toMatch(/Gmail API is enabled in your Google Cloud project/);
    expect(String(failure)).not.toContain(TOKEN);
  });
});

function rawSubject(subject: string): string {
  // Mirrors the encoding of a non-ASCII subject.
  const raw = Buffer.from(rawMessage({ to: ["a@b.c"], subject, body: "" }), "base64url").toString("utf8");
  return raw
    .split("\r\n")
    .find((line) => line.startsWith("Subject: "))!
    .slice(9);
}
