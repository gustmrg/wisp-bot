import { describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../shared/contracts.js";
import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import {
  PiConversationAgent,
  type PiSessionFactory,
  type PiSessionLike,
} from "../electron/backend/pi-conversation-agent.js";
import type { PiAgentEvent } from "../electron/backend/pi-event-translator.js";

class MockPiSession implements PiSessionLike {
  isIdle = true;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly toolRevision: string;
  readonly prompts: string[] = [];
  readonly models: unknown[] = [];
  abortCount = 0;
  disposeCount = 0;
  reloadCount = 0;
  private readonly listeners = new Set<(event: PiAgentEvent) => void>();
  private releasePrompt: (() => void) | null = null;

  constructor(id: string, toolRevision = "no-integrations") {
    this.sessionId = `${id}-pi`;
    this.sessionFile = `/sessions/${id}.jsonl`;
    this.toolRevision = toolRevision;
  }

  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.isIdle = false;
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `reply:${text}` } });
    await new Promise<void>((resolve) => {
      this.releasePrompt = resolve;
    });
    this.isIdle = true;
    this.emit({ type: "agent_settled" });
  }

  finishPrompt(): void {
    this.releasePrompt?.();
    this.releasePrompt = null;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.isIdle = true;
    this.finishPrompt();
  }

  async waitForIdle(): Promise<void> {}

  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  async setModel(model: never): Promise<void> {
    this.models.push(model);
  }

  getActiveToolNames(): string[] {
    return ["read", "grep", "find", "ls"];
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  private emit(event: PiAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function context(conversationId: string): ConversationAgentContext {
  return {
    conversationId,
    sessionId: `${conversationId}-session`,
    name: conversationId,
    label: "Test",
    description: "Test Wisp",
    userName: "John",
    workspaceDirectory: `/workspaces/${conversationId}`,
    sessionDirectory: `/sessions/${conversationId}`,
    configDirectory: `/config/${conversationId}`,
    piSessionId: null,
    piSessionFile: null,
  };
}

function selection(modelId = "model-1"): ModelSelection {
  return { providerId: "provider", modelId };
}

function factoryFor(sessions: Map<string, MockPiSession>): PiSessionFactory {
  return {
    resolveModel: (model) => ({ provider: model.providerId, id: model.modelId }) as never,
    create: async (agentContext) => {
      const session = new MockPiSession(agentContext.conversationId);
      sessions.set(agentContext.conversationId, session);
      return session;
    },
    getToolRevision: async () => null,
  };
}

function rebuildingFactory(sessions: MockPiSession[], revisions: Array<string | null>): PiSessionFactory {
  return {
    resolveModel: (model) => ({ provider: model.providerId, id: model.modelId }) as never,
    create: async (agentContext) => {
      const revision = revisions[sessions.length] ?? "no-integrations";
      const session = new MockPiSession(`wisp-${sessions.length}`, revision);
      sessions.push(session);
      return session;
    },
    getToolRevision: async () => revisions[sessions.length] ?? null,
  };
}

describe("PiConversationAgent", () => {
  it("requires explicit configuration before sending", async () => {
    const agent = new PiConversationAgent(context("one"), factoryFor(new Map()));
    await agent.start();

    await expect(agent.send({ conversationId: "one", requestId: "r1", text: "Hello" })).rejects.toMatchObject({
      code: "configuration_required",
    });

    await agent.applyModel(selection());
    await agent.clearModel();
    await expect(agent.send({ conversationId: "one", requestId: "r2", text: "Hello" })).rejects.toMatchObject({
      code: "configuration_required",
    });
    await agent.dispose();
  });

  it("keeps separate Wisp histories and stages model changes until idle", async () => {
    const sessions = new Map<string, MockPiSession>();
    const factory = factoryFor(sessions);
    const one = new PiConversationAgent(context("one"), factory, { flushDelayMs: 0 });
    const two = new PiConversationAgent(context("two"), factory, { flushDelayMs: 0 });
    await Promise.all([one.start(), two.start(), one.applyModel(selection()), two.applyModel(selection())]);

    const firstPrompt = one.send({ conversationId: "one", requestId: "one-1", text: "First" });
    const secondPrompt = two.send({ conversationId: "two", requestId: "two-1", text: "Second" });
    await vi.waitFor(() => {
      expect(sessions.get("one")?.isIdle).toBe(false);
      expect(sessions.get("two")?.isIdle).toBe(false);
    });
    await one.applyModel(selection("model-2"));
    expect(sessions.get("one")?.models).toEqual([]);
    sessions.get("one")?.finishPrompt();
    sessions.get("two")?.finishPrompt();
    await Promise.all([firstPrompt, secondPrompt]);

    expect(sessions.get("one")?.prompts).toEqual(["First"]);
    expect(sessions.get("two")?.prompts).toEqual(["Second"]);
    expect(sessions.get("one")?.models).toHaveLength(1);
    expect(sessions.get("two")?.models).toEqual([]);
  });

  it("aborts active work and disposes the Pi session exactly once", async () => {
    const sessions = new Map<string, MockPiSession>();
    const agent = new PiConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0 });
    const events = vi.fn();
    agent.subscribe(events);
    await agent.start();
    await agent.applyModel(selection());
    const prompt = agent.send({ conversationId: "one", requestId: "one-1", text: "Wait" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));

    await agent.abort();
    await prompt;
    await agent.dispose();
    await agent.dispose();

    expect(sessions.get("one")?.abortCount).toBe(1);
    expect(sessions.get("one")?.disposeCount).toBe(1);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_message_cancelled" }));
  });

  it("reloads the active session when its identity changes", async () => {
    const sessions = new Map<string, MockPiSession>();
    const initialContext = context("one");
    const agent = new PiConversationAgent(initialContext, factoryFor(sessions));
    await agent.start();
    await agent.applyModel(selection());

    await agent.updateContext({ ...initialContext, description: "Financial advisor", userName: "Jane" });

    expect(initialContext.description).toBe("Financial advisor");
    expect(initialContext.userName).toBe("Jane");
    expect(sessions.get("one")?.reloadCount).toBe(1);
    await agent.dispose();
  });
});

it("reports the model actually used while an override waits for the active turn", async () => {
  const sessions = new Map<string, MockPiSession>();
  const agent = new PiConversationAgent(context("one"), factoryFor(sessions));
  const events = vi.fn();
  agent.subscribe(events);
  await agent.start();
  await agent.applyModel(selection());
  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
  await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
  await agent.applyModel(selection("override"));
  expect(events).toHaveBeenCalledWith({
    type: "conversation_model_changed",
    conversationId: "one",
    applied: selection(),
    pending: selection("override"),
  });
  expect(sessions.get("one")?.models).toHaveLength(0);
  sessions.get("one")?.finishPrompt();
  await send;
  expect(events).toHaveBeenCalledWith({
    type: "conversation_model_changed",
    conversationId: "one",
    applied: selection("override"),
    pending: null,
  });
  expect(sessions.get("one")?.models).toHaveLength(1);
  await agent.dispose();
});

it("rebuilds the session at the next message when the tool snapshot changes, preserving identity", async () => {
  const created: MockPiSession[] = [];
  // First fetch (at send) returns a changed revision, forcing one rebuild.
  const factory = rebuildingFactory(created, ["rev-1", "rev-2", "rev-2"]);
  const agentContext = context("one");
  const agent = new PiConversationAgent(agentContext, factory, { flushDelayMs: 0 });
  const events = vi.fn();
  agent.subscribe(events);
  await agent.start();
  await agent.applyModel(selection());

  expect(created).toHaveLength(1);
  expect(created[0]?.toolRevision).toBe("rev-1");
  expect(agentContext.piSessionId).toBe(created[0]?.sessionId);
  expect(agentContext.piSessionFile).toBe(created[0]?.sessionFile);

  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
  await vi.waitFor(() => expect(created).toHaveLength(2));
  expect(created[1]?.toolRevision).toBe("rev-2");
  expect(created[0]?.disposeCount).toBe(1);
  expect(created[1]?.disposeCount).toBe(0);
  created[1]?.finishPrompt();
  await send;

  expect(created[1]?.prompts).toEqual(["Hello"]);
  // The rebuilt session reopens the exact same Pi session file: no new
  // conversation, no new topic.
  expect(agentContext.piSessionId).toBe(created[1]?.sessionId);
  expect(agentContext.piSessionFile).toBe(created[1]?.sessionFile);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_message_completed" }));
  await agent.dispose();
  expect(created[1]?.disposeCount).toBe(1);
});

it("does not rebuild while the previous tool revision is still current", async () => {
  const created: MockPiSession[] = [];
  const factory = rebuildingFactory(created, ["rev-1", "rev-1"]);
  const agentContext = context("one");
  const agent = new PiConversationAgent(agentContext, factory, { flushDelayMs: 0 });
  await agent.start();
  await agent.applyModel(selection());

  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
  await vi.waitFor(() => expect(created[0]?.prompts).toEqual(["Hello"]));
  created[0]?.finishPrompt();
  await send;

  expect(created).toHaveLength(1);
  await agent.dispose();
});
