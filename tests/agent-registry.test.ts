import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../electron/backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../electron/backend/conversation-agent.js";
import { FakeConversationAgent } from "../electron/backend/fake-conversation-agent.js";
import type { ConversationAgentEvent, SequencedConversationAgentEvent } from "../shared/contracts.js";

function context(conversationId: string): ConversationAgentContext {
  return {
    conversationId,
    sessionId: `${conversationId}-session`,
    workspaceDirectory: `/tmp/${conversationId}/workspace`,
    sessionDirectory: `/tmp/${conversationId}/session`,
    configDirectory: `/tmp/${conversationId}/config`,
  };
}

describe("AgentRegistry", () => {
  it("creates exactly one agent per Wisp and restores idempotently", async () => {
    const create = vi.fn((agentContext: ConversationAgentContext) => (
      new FakeConversationAgent(agentContext.conversationId)
    ));
    const factory: ConversationAgentFactory = { create };
    const registry = new AgentRegistry(factory, () => undefined);

    await registry.restore([context("one"), context("two")], null);
    await registry.restore([context("one"), context("two")], null);

    expect(create).toHaveBeenCalledTimes(2);
    expect(registry.list().sort()).toEqual(["one", "two"]);
    expect(registry.statuses()).toEqual({
      one: "configuration_required",
      two: "configuration_required",
    });
    await registry.delete("one");
    expect(registry.has("one")).toBe(false);
    await registry.disposeAll();
    expect(registry.list()).toEqual([]);
  });

  it("keeps FIFO order within a Wisp while independent Wisps run concurrently", async () => {
    const events: SequencedConversationAgentEvent[] = [];
    const factory: ConversationAgentFactory = {
      create: (agentContext) => new FakeConversationAgent(agentContext.conversationId, { latencyMs: 15 }),
    };
    const registry = new AgentRegistry(factory, (event) => events.push(event));
    await registry.restore([context("one"), context("two")], null);

    await Promise.all([
      registry.send({ conversationId: "one", requestId: "one-a", text: "A" }),
      registry.send({ conversationId: "one", requestId: "one-b", text: "B" }),
      registry.send({ conversationId: "two", requestId: "two-a", text: "C" }),
    ]);

    const lifecycle = events.filter((event) => (
      event.type === "assistant_message_started" || event.type === "assistant_message_completed"
    )).map((event) => `${event.type}:${event.requestId}`);
    expect(lifecycle.indexOf("assistant_message_completed:one-a"))
      .toBeLessThan(lifecycle.indexOf("assistant_message_started:one-b"));
    expect(lifecycle.indexOf("assistant_message_started:two-a"))
      .toBeLessThan(lifecycle.indexOf("assistant_message_completed:one-a"));
    expect(events.map(({ sequence }) => sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(registry.getEventSequence()).toBe(events.length);
    await registry.disposeAll();
  });

  it("keeps the registry entry in configuration_required when Pi restoration fails", async () => {
    const published: ConversationAgentEvent[] = [];
    const factory: ConversationAgentFactory = {
      create: (agentContext) => {
        const agent = new FakeConversationAgent(agentContext.conversationId);
        agent.applyModel = async () => {
          throw new Error("raw Pi restore failure");
        };
        return agent;
      },
    };
    const registry = new AgentRegistry(factory, (event) => published.push(event));

    await expect(registry.restore([context("one")], {
      providerId: "provider",
      modelId: "model",
    })).resolves.toBeUndefined();

    expect(registry.list()).toEqual(["one"]);
    expect(registry.statuses()).toEqual({ one: "configuration_required" });
    expect(published).toContainEqual(expect.objectContaining({
      type: "conversation_error",
      error: expect.objectContaining({ message: "The backend could not complete the request." }),
    }));
    expect(JSON.stringify(published)).not.toContain("raw Pi restore failure");
    await registry.disposeAll();
  });

  it("limits per-Wisp queue depth and simultaneous active agents", async () => {
    let active = 0;
    let maximumActive = 0;
    const factory: ConversationAgentFactory = {
      create: (agentContext) => {
        const agent = new FakeConversationAgent(agentContext.conversationId, { latencyMs: 20 });
        const send = agent.send.bind(agent);
        agent.send = async (request) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            await send(request);
          } finally {
            active -= 1;
          }
        };
        return agent;
      },
    };
    const registry = new AgentRegistry(factory, () => undefined);
    const contexts = Array.from({ length: 8 }, (_value, index) => context(`wisp-${index}`));
    await registry.restore(contexts, null);
    await Promise.all(contexts.map(({ conversationId }, index) => registry.send({
      conversationId,
      requestId: `load-${index}`,
      text: "Load test",
    })));
    expect(maximumActive).toBeLessThanOrEqual(4);

    const queued = Array.from({ length: 8 }, (_value, index) => registry.send({
      conversationId: "wisp-0",
      requestId: `queued-${index}`,
      text: "Queued",
    }));
    await expect(Promise.resolve().then(() => registry.send({
      conversationId: "wisp-0",
      requestId: "queued-overflow",
      text: "Overflow",
    }))).rejects.toMatchObject({ code: "invalid_request" });
    await Promise.all(queued);
    await registry.disposeAll();
  });

  it("does not run queued work after its conversation is deleted", async () => {
    const disposed = vi.fn();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registry = new AgentRegistry({
      create: (agentContext) => new FakeConversationAgent(agentContext.conversationId, { latencyMs: 50 }),
    }, (event) => {
      if (event.type === "assistant_message_started" && event.requestId === "first") markStarted?.();
    }, disposed);
    await registry.restore([context("one")], null);

    const first = registry.send({ conversationId: "one", requestId: "first", text: "First" });
    await started;
    const second = registry.send({ conversationId: "one", requestId: "second", text: "Second" });
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "disposed" });
    await registry.delete("one");

    await first;
    await secondExpectation;
    expect(disposed).toHaveBeenCalledWith("one");
  });
});
