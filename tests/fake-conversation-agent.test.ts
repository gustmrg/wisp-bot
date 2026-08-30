import { describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../electron/backend/backend-error.js";
import { FakeConversationAgent } from "../electron/backend/fake-conversation-agent.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";

describe("FakeConversationAgent", () => {
  it("emits an ordered lifecycle for a message", async () => {
    const agent = new FakeConversationAgent("wisp-1", {
      responseFor: ({ text }) => `Reply: ${text}`,
    });
    const events: ConversationAgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await agent.start();
    await agent.send({ conversationId: "wisp-1", requestId: "request-1", text: "Hello" });

    expect(events.map((event) => event.type)).toEqual([
      "conversation_status",
      "conversation_status",
      "assistant_message_started",
      "assistant_text_delta",
      "assistant_message_completed",
      "conversation_status",
    ]);
    expect(events[3]).toMatchObject({
      type: "assistant_text_delta",
      conversationId: "wisp-1",
      requestId: "request-1",
      messageId: "fake-request-1",
      delta: "Reply: Hello",
    });
  });

  it("processes messages in FIFO order", async () => {
    const agent = new FakeConversationAgent("wisp-1", { latencyMs: 5 });
    const completed: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "assistant_message_completed") completed.push(event.requestId);
    });
    await agent.start();

    await Promise.all([
      agent.send({ conversationId: "wisp-1", requestId: "first", text: "First" }),
      agent.send({ conversationId: "wisp-1", requestId: "second", text: "Second" }),
    ]);

    expect(completed).toEqual(["first", "second"]);
  });

  it("cancels the active message and remains usable", async () => {
    const agent = new FakeConversationAgent("wisp-1", { latencyMs: 100 });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));
    await agent.start();

    const pending = agent.send({ conversationId: "wisp-1", requestId: "cancel-me", text: "Wait" });
    await vi.waitFor(() => expect(eventTypes).toContain("assistant_message_started"));
    await agent.abort();
    await pending;
    await agent.send({ conversationId: "wisp-1", requestId: "next", text: "Continue" });

    expect(eventTypes).toContain("assistant_message_cancelled");
    expect(eventTypes).toContain("assistant_message_completed");
  });

  it("unsubscribes listeners and disposes idempotently", async () => {
    const agent = new FakeConversationAgent("wisp-1");
    const listener = vi.fn();
    const unsubscribe = agent.subscribe(listener);
    unsubscribe();

    await agent.start();
    expect(listener).not.toHaveBeenCalled();

    await agent.dispose();
    await agent.dispose();
    await expect(Promise.resolve().then(() => agent.send({
      conversationId: "wisp-1",
      requestId: "request-1",
      text: "Hello",
    }))).rejects.toBeInstanceOf(WispBackendError);
  });

  it("stores model changes without exposing implementation-specific types", async () => {
    const agent = new FakeConversationAgent("wisp-1");
    await agent.start();
    await agent.applyModel({ providerId: "provider", modelId: "model" });

    expect(agent.selectedModel).toEqual({ providerId: "provider", modelId: "model" });
  });
});
