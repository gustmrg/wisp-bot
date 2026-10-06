import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../backend/conversation-agent.js";
import { FakeConversationAgent } from "../backend/fake-conversation-agent.js";
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
    const create = vi.fn(
      (agentContext: ConversationAgentContext) => new FakeConversationAgent(agentContext.conversationId),
    );
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
    await registry.restore([context("one"), context("two")], { providerId: "test", modelId: "test" });

    await Promise.all([
      registry.send({ conversationId: "one", requestId: "one-a", text: "A" }),
      registry.send({ conversationId: "one", requestId: "one-b", text: "B" }),
      registry.send({ conversationId: "two", requestId: "two-a", text: "C" }),
    ]);

    const lifecycle = events
      .filter((event) => event.type === "assistant_message_started" || event.type === "assistant_message_completed")
      .map((event) => `${event.type}:${event.requestId}`);
    expect(lifecycle.indexOf("assistant_message_completed:one-a")).toBeLessThan(
      lifecycle.indexOf("assistant_message_started:one-b"),
    );
    expect(lifecycle.indexOf("assistant_message_started:two-a")).toBeLessThan(
      lifecycle.indexOf("assistant_message_completed:one-a"),
    );
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_event, index) => index + 1));
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

    await expect(
      registry.restore([context("one")], {
        providerId: "provider",
        modelId: "model",
      }),
    ).resolves.toBeUndefined();

    expect(registry.list()).toEqual(["one"]);
    expect(registry.statuses()).toEqual({ one: "configuration_required" });
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({ message: "The backend could not complete the request." }),
      }),
    );
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
    await registry.restore(contexts, { providerId: "test", modelId: "test" });
    await Promise.all(
      contexts.map(({ conversationId }, index) =>
        registry.send({
          conversationId,
          requestId: `load-${index}`,
          text: "Load test",
        }),
      ),
    );
    expect(maximumActive).toBeLessThanOrEqual(4);

    const queued = Array.from({ length: 8 }, (_value, index) =>
      registry.send({
        conversationId: "wisp-0",
        requestId: `queued-${index}`,
        text: "Queued",
      }),
    );
    await expect(
      Promise.resolve().then(() =>
        registry.send({
          conversationId: "wisp-0",
          requestId: "queued-overflow",
          text: "Overflow",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await Promise.all(queued);
    await registry.disposeAll();
  });

  it("does not run queued work after its conversation is deleted", async () => {
    const disposed = vi.fn();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registry = new AgentRegistry(
      {
        create: (agentContext) => new FakeConversationAgent(agentContext.conversationId, { latencyMs: 50 }),
      },
      (event) => {
        if (event.type === "assistant_message_started" && event.requestId === "first") markStarted?.();
      },
      disposed,
    );
    await registry.restore([context("one")], { providerId: "test", modelId: "test" });

    const first = registry.send({ conversationId: "one", requestId: "first", text: "First" });
    await started;
    const second = registry.send({ conversationId: "one", requestId: "second", text: "Second" });
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "disposed" });
    await registry.delete("one");

    await first;
    await secondExpectation;
    expect(disposed).toHaveBeenCalledWith("one");
  });

  it("rejects duplicate request IDs without invoking the agent twice", async () => {
    const agent = new FakeConversationAgent("one");
    const send = vi.spyOn(agent, "send");
    const registry = new AgentRegistry({ create: () => agent }, () => undefined);
    await registry.restore([context("one")], { providerId: "test", modelId: "test" });

    await registry.send({ conversationId: "one", requestId: "same-request", text: "First" });
    await expect(
      Promise.resolve().then(() =>
        registry.send({ conversationId: "one", requestId: "same-request", text: "Duplicate" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(send).toHaveBeenCalledTimes(1);
    await registry.disposeAll();
  });

  it("aborts timed-out work and publishes one retryable error terminal", async () => {
    vi.useFakeTimers();
    const events: SequencedConversationAgentEvent[] = [];
    const agent = new FakeConversationAgent("one", { latencyMs: 60_000 });
    const abort = vi.spyOn(agent, "abort");
    const registry = new AgentRegistry(
      { create: () => agent },
      (event) => events.push(event),
      () => undefined,
      {
        executionTimeoutMs: 100,
      },
    );
    await registry.restore([context("one")], { providerId: "test", modelId: "test" });

    registry.dispatch({ conversationId: "one", requestId: "deadline", text: "Slow" });
    await vi.advanceTimersByTimeAsync(101);
    await Promise.resolve();
    await Promise.resolve();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "assistant_message_cancelled")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        requestId: "deadline",
        error: expect.objectContaining({ code: "aborted", retryable: true }),
      }),
    );
    await registry.disposeAll();
    vi.useRealTimers();
  });
});

it("never publishes idle or accepts a message before configuration, then enables the new Wisp", async () => {
  const events: SequencedConversationAgentEvent[] = [];
  const registry = new AgentRegistry({ create: (ctx) => new FakeConversationAgent(ctx.conversationId) }, (event) =>
    events.push(event),
  );
  await registry.create(context("new"));
  expect(events.filter((event) => event.type === "conversation_status").map((event) => event.status)).toEqual([
    "configuration_required",
    "configuration_required",
  ]);
  expect(() => registry.send({ conversationId: "new", requestId: "first", text: "Hello" })).toThrow(/Configure/);
  expect(events.some((event) => event.type === "conversation_error")).toBe(false);
  await registry.applyModel({ providerId: "provider", modelId: "model" });
  expect(registry.statuses().new).toBe("idle");
  await expect(registry.send({ conversationId: "new", requestId: "first", text: "Hello" })).resolves.toBeUndefined();
  await registry.disposeAll();
});

it("isolates overrides, keeps them when the global model changes, and restores inheritance", async () => {
  const registry = new AgentRegistry(
    { create: (ctx) => new FakeConversationAgent(ctx.conversationId) },
    () => undefined,
  );
  const global = { providerId: "provider-a", modelId: "global" };
  const override = { providerId: "provider-b", modelId: "override", maxOutputTokens: 500 };
  await registry.restore([context("one"), { ...context("two"), modelOverride: override }], global);
  expect(registry.getModelView("two")).toMatchObject({
    override,
    effective: override,
    applied: override,
    status: "idle",
  });
  await registry.applyModel({ ...global, modelId: "new-global" });
  expect(registry.getModelView("one").applied?.modelId).toBe("new-global");
  expect(registry.getModelView("two").applied).toEqual(override);
  await registry.applyModel(null);
  expect(registry.statuses()).toEqual({ one: "configuration_required", two: "idle" });
  await registry.applyConversationModel("two", null);
  expect(registry.getModelView("two")).toMatchObject({
    override: null,
    effective: null,
    status: "configuration_required",
  });
  await registry.disposeAll();
});

it("disables only overrides whose credentials were removed and recovers when the key returns", async () => {
  let revoked = false;
  const global = { providerId: "a", modelId: "global" };
  const override = { providerId: "b", modelId: "override" };
  const registry = new AgentRegistry(
    { create: (ctx) => new FakeConversationAgent(ctx.conversationId) },
    () => undefined,
    () => undefined,
    {
      validateModel: async (model) => {
        if (revoked && model.providerId === "b") throw new Error("Credential missing");
      },
    },
  );
  await registry.restore([context("one"), { ...context("two"), modelOverride: override }], global);
  revoked = true;
  await registry.applyModel(global);
  expect(registry.statuses()).toEqual({ one: "idle", two: "configuration_required" });
  expect(registry.getModelView("two")).toMatchObject({ override, applied: null });
  revoked = false;
  await registry.applyModel(global);
  expect(registry.getModelView("two")).toMatchObject({ override, applied: override, status: "idle" });
  await registry.disposeAll();
});

it("serializes context renewal before incoming messages and rejects renewal during queued work", async () => {
  const { DEFAULT_CONTEXT_POLICY } = await import("../shared/context-policy.js");
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const manageContext = vi.fn(async () => {
    await released;
    return {
      policy: DEFAULT_CONTEXT_POLICY,
      memory: "",
      summary: "Summary",
      lastRenewedAt: null,
      lastActivityAt: null,
      tokens: 1000,
    };
  });
  const agent = Object.assign(new FakeConversationAgent("one", { latencyMs: 1 }), { manageContext });
  const send = vi.spyOn(agent, "send");
  const registry = new AgentRegistry({ create: () => agent }, () => undefined);
  await registry.restore([context("one")], { providerId: "test", modelId: "test" });
  const renewal = registry.manageContext({ conversationId: "one", command: { action: "compact" } });
  await vi.waitFor(() => expect(manageContext).toHaveBeenCalledOnce());
  const message = registry.send({ conversationId: "one", requestId: "after-renewal", text: "Continue" });
  expect(send).not.toHaveBeenCalled();
  await expect(registry.manageContext({ conversationId: "one", command: { action: "new_topic" } })).rejects.toThrow(
    /finish/,
  );
  finish();
  await renewal;
  await message;
  expect(send).toHaveBeenCalledOnce();
  expect(registry.statuses().one).toBe("idle");
  await registry.disposeAll();
});
