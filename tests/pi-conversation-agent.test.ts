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
  readonly prompts: string[] = [];
  readonly models: unknown[] = [];
  abortCount = 0;
  disposeCount = 0;
  private readonly listeners = new Set<(event: PiAgentEvent) => void>();
  private releasePrompt: (() => void) | null = null;

  constructor(id: string) {
    this.sessionId = `${id}-pi`;
    this.sessionFile = `/sessions/${id}.jsonl`;
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
    await Promise.resolve();
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
    await Promise.resolve();

    await agent.abort();
    await prompt;
    await agent.dispose();
    await agent.dispose();

    expect(sessions.get("one")?.abortCount).toBe(1);
    expect(sessions.get("one")?.disposeCount).toBe(1);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_message_cancelled" }));
  });
});
