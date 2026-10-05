import { describe, expect, it } from "vitest";

import { readServerSentEvents, type SseMessage } from "../../client/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readServerSentEvents", () => {
  it("parses events split across chunks, with CRLF and multi-line data", async () => {
    const messages: SseMessage[] = [];
    let activity = 0;
    await readServerSentEvents(
      streamOf([
        "retry: 2000\n\nid: b:1\nev",
        'ent: agentEvent\ndata: {"a"',
        ":1}\n\n: keep-alive\n\n",
        "event: x\r\ndata: one\r\ndata: two\r\n\r\n",
      ]),
      (message) => messages.push(message),
      () => activity++,
    );
    expect(messages).toEqual([
      { id: "b:1", event: "agentEvent", data: '{"a":1}' },
      { event: "x", data: "one\ntwo" },
    ]);
    expect(activity).toBe(4);
  });
});
