import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeQueuedMessage } from "../backend/message-queue.js";
import { MAX_QUEUED_MESSAGES_PER_WISP } from "../shared/message-queue.js";
import { MODEL, newWisp, setupMessaging } from "./helpers/messaging-harness.js";

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
    await harness.service.createWisp(newWisp("two"), { notifyOnUpdatesEnabled: true });
    await harness.queue.enqueue("two", "Never sent");
    await harness.service.deleteWisp("two");

    expect(harness.removed).toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.queueViews.at(-1)).toEqual({ messages: [] }));
    await harness.close();
  });

  describe("follow-ups", () => {
    async function working() {
      const harness = await setupMessaging({ latencyMs: 1_000, steering: true });
      await harness.queue.enqueue("one", "First");
      await vi.waitFor(() => expect(harness.registry.statuses().one).toBe("working"));
      return harness;
    }

    it("hands a message sent while the Wisp works to its running turn, which answers it next", async () => {
      const harness = await working();
      const view = await harness.queue.enqueue("one", "Also this");
      expect(view.messages).toEqual([expect.objectContaining({ id: "queued-2", followUp: true })]);

      await harness.advance(1_000);
      await vi.waitFor(async () => {
        expect(summary(await harness.transcript())).toEqual([
          "outgoing:First:complete",
          "incoming:Fake response to: First:complete",
          "outgoing:Also this:complete",
          "incoming:Fake response to: Also this:complete",
        ]);
      });
      expect((await harness.queue.getView()).messages).toEqual([]);
      expect(harness.queueViews.at(-1)).toEqual({ messages: [] });
      // The follow-up was answered in the same turn, never sent as a request of its own.
      expect(() => harness.registry.send({ conversationId: "one", requestId: "queued-2", text: "Again" })).toThrow(
        /already been accepted/,
      );
      await harness.close();
    });

    it("gives back the follow-ups a stopped turn never read, out of the queue", async () => {
      const harness = await working();
      await harness.queue.enqueue("one", "Also this");
      await harness.queue.enqueue("one", "And this");

      const returned = await harness.queue.returnFollowUps(await harness.registry.abort("one"));
      expect(returned.map(({ text }) => text)).toEqual(["Also this", "And this"]);
      expect((await harness.queue.getView()).messages).toEqual([]);

      await harness.advance(1_000);
      await vi.waitFor(async () => {
        expect(summary(await harness.transcript())).toEqual(["outgoing:First:complete", "incoming::cancelled"]);
      });
      await harness.close();
    });

    it("hands a changed follow-up over again, and drops a cancelled one", async () => {
      const harness = await working();
      await harness.queue.enqueue("one", "Also this");
      await harness.queue.enqueue("one", "Never mind");
      await harness.queue.update("queued-2", "Also this, changed");
      const view = await harness.queue.cancel("queued-3");
      expect(view.messages).toEqual([
        expect.objectContaining({ id: "queued-2", text: "Also this, changed", followUp: true }),
      ]);

      await harness.advance(1_000);
      await vi.waitFor(async () => {
        expect(summary(await harness.transcript())).toEqual([
          "outgoing:First:complete",
          "incoming:Fake response to: First:complete",
          "outgoing:Also this, changed:complete",
          "incoming:Fake response to: Also this, changed:complete",
        ]);
      });
      await harness.close();
    });

    it("leaves a scheduled message, and what comes after it, for the next turn", async () => {
      const harness = await working();
      await harness.queue.enqueue("one", "Scheduled", {
        scheduled: { scheduledMessageId: "scheduled-1", scheduledAt: "2026-10-06T12:00:00.000Z", timeZone: "UTC" },
      });
      const view = await harness.queue.enqueue("one", "After it");
      expect(view.messages.map(({ followUp }) => followUp)).toEqual([undefined, undefined]);
      await harness.close();
    });

    it("waits for the next turn when the Wisp's agent cannot take follow-ups", async () => {
      const harness = await setupMessaging({ latencyMs: 1_000 });
      await harness.queue.enqueue("one", "First");
      await vi.waitFor(() => expect(harness.registry.statuses().one).toBe("working"));
      const view = await harness.queue.enqueue("one", "Second");
      expect(view.messages).toEqual([expect.not.objectContaining({ followUp: true })]);
      await harness.close();
    });
  });

  it("skips stored records it cannot read", () => {
    expect(normalizeQueuedMessage({ id: "x", conversationId: "one", text: " " })).toBeUndefined();
  });
});
