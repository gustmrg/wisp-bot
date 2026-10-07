import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeQueuedMessage } from "../backend/message-queue.js";
import { MAX_QUEUED_MESSAGES_PER_WISP } from "../shared/message-queue.js";
import { MODEL, setupMessaging, wisp } from "./helpers/messaging-harness.js";

function summary(messages: ReadonlyArray<{ type: string; text?: string; status?: string }>) {
  return messages.map((message) => `${message.type}:${message.text ?? ""}:${message.status ?? ""}`);
}

describe("MessageQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a free Wisp the message right away", async () => {
    const harness = await setupMessaging();
    await harness.queue.enqueue("one", "Hello");

    await vi.waitFor(async () => {
      expect(summary(await harness.transcript())).toEqual([
        "outgoing:Hello:complete",
        "incoming:Fake response to: Hello:complete",
      ]);
    });
    expect((await harness.queue.getView()).messages).toEqual([]);
    expect(harness.queueViews.at(-1)).toEqual({ messages: [] });
    await harness.close();
  });

  it("keeps a message out of the transcript until the Wisp has answered the one before", async () => {
    const harness = await setupMessaging({ latencyMs: 1_000 });
    await harness.queue.enqueue("one", "First");
    const outgoing = async () => summary(await harness.transcript()).filter((line) => line.startsWith("outgoing"));
    await vi.waitFor(async () => expect(await outgoing()).toEqual(["outgoing:First:complete"]));

    await harness.queue.enqueue("one", "Second");
    expect((await harness.queue.getView()).messages).toEqual([
      expect.objectContaining({ id: "queued-2", conversationId: "one", text: "Second" }),
    ]);
    expect(await outgoing()).toEqual(["outgoing:First:complete"]);

    await harness.advance(1_000);
    await harness.advance(1_000);
    await vi.waitFor(async () => {
      expect(summary(await harness.transcript())).toEqual([
        "outgoing:First:complete",
        "incoming:Fake response to: First:complete",
        "outgoing:Second:complete",
        "incoming:Fake response to: Second:complete",
      ]);
    });
    expect((await harness.queue.getView()).messages).toEqual([]);
    await harness.close();
  });

  it("edits and cancels a message only while it waits", async () => {
    const harness = await setupMessaging({ model: null });
    await harness.queue.enqueue("one", "Draft");
    await harness.queue.enqueue("one", "Another");

    const edited = await harness.queue.update("queued-1", "Draft, edited");
    // An edit keeps the message's place in line.
    expect(edited.messages.map(({ id, text }) => [id, text])).toEqual([
      ["queued-1", "Draft, edited"],
      ["queued-2", "Another"],
    ]);
    expect((await harness.queue.cancel("queued-2")).messages.map(({ id }) => id)).toEqual(["queued-1"]);

    await harness.service.applyModel(MODEL);
    await vi.waitFor(async () => expect((await harness.transcript())[0]).toMatchObject({ text: "Draft, edited" }));
    await expect(harness.queue.cancel("queued-1")).rejects.toMatchObject({ code: "not_found" });
    await harness.close();
  });

  it("limits what the person queues, but never drops a scheduled message", async () => {
    const harness = await setupMessaging({ model: null });
    for (let index = 0; index < MAX_QUEUED_MESSAGES_PER_WISP; index += 1) {
      await harness.queue.enqueue("one", `Message ${index}`);
    }
    await expect(harness.queue.enqueue("one", "One too many")).rejects.toMatchObject({ code: "invalid_request" });
    const scheduled = await harness.queue.enqueue("one", "Scheduled", {
      scheduled: { scheduledMessageId: "scheduled-1", scheduledAt: "2026-10-05T12:00:00.000Z", timeZone: "UTC" },
    });
    expect(scheduled.messages).toHaveLength(MAX_QUEUED_MESSAGES_PER_WISP + 1);
    await expect(harness.queue.enqueue("missing", "Hello")).rejects.toMatchObject({ code: "not_found" });
    await harness.close();
  });

  it("sends what was still waiting after Wisp starts again", async () => {
    const first = await setupMessaging({ model: null });
    await first.queue.enqueue("one", "Waiting");
    await first.close();

    const second = await setupMessaging({ directory: first.directory });
    await second.queue.start();
    await vi.waitFor(async () => {
      expect(summary(await second.transcript())).toEqual([
        "outgoing:Waiting:complete",
        "incoming:Fake response to: Waiting:complete",
      ]);
    });
    await second.close();
  });

  it("fails a message the Wisp never answered before Wisp stopped, so it can be retried", async () => {
    const first = await setupMessaging();
    await first.repository.appendOutgoingMessage("one", {
      id: "interrupted",
      type: "outgoing",
      text: "Halfway",
      status: "queued",
      createdAt: "2026-10-06T11:00:00.000Z",
    });
    await first.close();

    const second = await setupMessaging({ directory: first.directory });
    await vi.waitFor(async () => {
      const messages = await second.transcript();
      expect(messages[0]).toMatchObject({ id: "interrupted", status: "failed" });
      expect(messages[1]).toMatchObject({ type: "incoming", status: "failed", retryable: true });
    });
    await second.close();
  });

  it("removes a Wisp's waiting messages with the Wisp", async () => {
    const harness = await setupMessaging({ model: null });
    await harness.service.create(wisp("two"));
    await harness.queue.enqueue("two", "Never sent");
    await harness.service.delete("two");

    expect(harness.removed).toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.queueViews.at(-1)).toEqual({ messages: [] }));
    await harness.close();
  });

  it("skips stored records it cannot read", () => {
    expect(normalizeQueuedMessage({ id: "x", conversationId: "one", text: " " })).toBeUndefined();
  });
});
