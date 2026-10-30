import { describe, expect, it, vi } from "vitest";

import type { ModelSelection, ThinkingLevel } from "../shared/contracts.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { RuntimeSessionFactory, RuntimeSession } from "../backend/runtime-session.js";
import { WispConversationAgent } from "../backend/wisp-conversation-agent.js";
import type { PiAgentEvent } from "../backend/pi-event-translator.js";
import { RuntimeEventLog } from "../backend/runtime-event-log.js";

class MockPiSession implements RuntimeSession {
  isIdle = true;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly toolRevision: string;
  readonly prompts: string[] = [];
  readonly models: unknown[] = [];
  readonly thinkingLevels: ThinkingLevel[] = [];
  /** Follow-ups handed to the running turn and not read yet. */
  steered: string[] = [];
  clearCount = 0;
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
    this.emit({ type: "message_start", message: { role: "user" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `reply:${text}` } });
    await new Promise<void>((resolve) => {
      this.releasePrompt = resolve;
    });
    this.isIdle = true;
    this.emit({ type: "agent_settled" });
  }

  steer(text: string): void {
    this.steered.push(text);
  }

  clearQueue(): void {
    this.clearCount += 1;
    this.steered = [];
  }

  /** The running turn reads its oldest follow-up, as Pi does between steps, and answers it. */
  readFollowUp(): void {
    const text = this.steered.shift();
    this.emit({ type: "message_start", message: { role: "user" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `reply:${text}` } });
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

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevels.push(level);
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
    wispId: conversationId,
    role: "Test",
    soul: "Test Wisp",
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

function factoryFor(sessions: Map<string, MockPiSession>): RuntimeSessionFactory {
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

function rebuildingFactory(sessions: MockPiSession[], revisions: Array<string | null>): RuntimeSessionFactory {
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

describe("WispConversationAgent", () => {
  it("requires explicit configuration before sending", async () => {
    const agent = new WispConversationAgent(context("one"), factoryFor(new Map()));
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
    const one = new WispConversationAgent(context("one"), factory, { flushDelayMs: 0 });
    const two = new WispConversationAgent(context("two"), factory, { flushDelayMs: 0 });
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

  it("opens a new session when the model moves to another runtime, such as Claude Code", async () => {
    const sessions: MockPiSession[] = [];
    const factory: RuntimeSessionFactory = {
      ...rebuildingFactory(sessions, []),
      sameRuntime: (current, next) => (current.providerId === "claude-code") === (next.providerId === "claude-code"),
    };
    const agent = new WispConversationAgent(context("one"), factory, { flushDelayMs: 0 });
    await agent.start();
    await agent.applyModel(selection());
    const first = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
    await vi.waitFor(() => expect(sessions[0]?.isIdle).toBe(false));

    // A change during a turn applies after it: the session closes rather than switching models.
    await agent.applyModel({ providerId: "claude-code", modelId: "sonnet" });
    sessions[0]!.finishPrompt();
    await first;
    expect(sessions[0]!.models).toEqual([]);
    expect(sessions[0]!.disposeCount).toBe(1);

    const second = agent.send({ conversationId: "one", requestId: "r2", text: "Again" });
    await vi.waitFor(() => expect(sessions[1]?.isIdle).toBe(false));
    sessions[1]!.finishPrompt();
    await second;
    expect(sessions[1]!.prompts).toEqual(["Again"]);

    // An idle session closes at once; a model of the same runtime switches in place.
    await agent.applyModel(selection("model-2"));
    expect(sessions[1]!.disposeCount).toBe(1);
    await agent.applyModel(selection("model-3"));
    expect(sessions).toHaveLength(2);
    await agent.dispose();
  });

  it("aborts active work and disposes the Pi session exactly once", async () => {
    const sessions = new Map<string, MockPiSession>();
    const agent = new WispConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0 });
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

  it("hands follow-ups to the running turn, which answers each after what it wrote so far", async () => {
    const sessions = new Map<string, MockPiSession>();
    const agent = new WispConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0 });
    const events: Array<Record<string, unknown>> = [];
    agent.subscribe((event) => events.push(event));
    await agent.start();
    await agent.applyModel(selection());
    expect(await agent.steer({ conversationId: "one", requestId: "r0", text: "Too early" })).toBe(false);

    const prompt = agent.send({ conversationId: "one", requestId: "r1", text: "First" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
    const session = sessions.get("one")!;
    expect(await agent.steer({ conversationId: "one", requestId: "r2", text: "Also this" })).toBe(true);
    expect(session.steered).toEqual(["Also this"]);
    session.readFollowUp();
    session.finishPrompt();
    await prompt;

    expect(
      events
        .filter(({ type }) => type !== "conversation_status" && type !== "conversation_model_changed")
        .map((event) => [event.type, event.requestId, event.messageId ?? event.followUpId ?? event.delta]),
    ).toEqual([
      ["assistant_message_started", "r1", "r1:assistant"],
      ["assistant_text_delta", "r1", "r1:assistant"],
      ["assistant_message_completed", "r1", "r1:assistant"],
      ["follow_up_taken", "r1", "r2"],
      ["assistant_message_started", "r2", "r2:assistant"],
      ["assistant_text_delta", "r2", "r2:assistant"],
      ["assistant_message_completed", "r2", "r2:assistant"],
    ]);
    expect(events.find((event) => event.type === "assistant_text_delta" && event.requestId === "r2")).toMatchObject({
      delta: "reply:Also this",
    });
  });

  it("gives back follow-ups the turn did not read, and never leaves them for the next prompt", async () => {
    const sessions = new Map<string, MockPiSession>();
    const agent = new WispConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0 });
    await agent.start();
    await agent.applyModel(selection());
    const first = agent.send({ conversationId: "one", requestId: "r1", text: "First" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
    const session = sessions.get("one")!;
    await agent.steer({ conversationId: "one", requestId: "r2", text: "Also this" });
    await agent.steer({ conversationId: "one", requestId: "r3", text: "And this" });

    expect(agent.withdrawFollowUps()).toEqual(["r2", "r3"]);
    expect(session.steered).toEqual([]);

    // One the turn ends without reading is dropped from Pi's queue; the queue sends it on its own.
    await agent.steer({ conversationId: "one", requestId: "r4", text: "Late" });
    session.finishPrompt();
    await first;
    expect(session.steered).toEqual([]);
    expect(session.clearCount).toBe(2);
    expect(agent.withdrawFollowUps()).toEqual([]);
  });

  it("reloads an open session when its identity changes", async () => {
    const sessions = new Map<string, MockPiSession>();
    const initialContext = context("one");
    const agent = new WispConversationAgent(initialContext, factoryFor(sessions), { flushDelayMs: 0 });
    await agent.start();
    await agent.applyModel(selection());
    const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
    sessions.get("one")?.finishPrompt();
    await send;

    await agent.updateContext({
      ...initialContext,
      soul: "Financial advisor",
      userName: "Jane",
      memory: { render: async () => "- [m1] Developer" } as never,
    });

    expect(initialContext.soul).toBe("Financial advisor");
    expect(initialContext.userName).toBe("Jane");
    expect(await initialContext.memory?.render()).toBe("- [m1] Developer");
    expect(sessions.get("one")?.reloadCount).toBe(1);
    await agent.dispose();
  });

  it("defers opening the Pi session until the Wisp is first used", async () => {
    const sessions = new Map<string, MockPiSession>();
    const initialContext = context("one");
    const agent = new WispConversationAgent(initialContext, factoryFor(sessions), { flushDelayMs: 0 });
    const events = vi.fn();
    agent.subscribe(events);
    await agent.start();

    await agent.applyModel(selection());
    await agent.updateContext({ ...initialContext, soul: "Financial advisor" });

    // Ready without loading history: startup cost no longer scales with every Wisp's transcript.
    expect(sessions.size).toBe(0);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: "conversation_model_changed", applied: selection() }),
    );
    const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
    await vi.waitFor(() => expect(sessions.get("one")?.prompts).toEqual(["Hello"]));
    sessions.get("one")?.finishPrompt();
    await send;
    const again = agent.send({ conversationId: "one", requestId: "r2", text: "Again" });
    await vi.waitFor(() => expect(sessions.get("one")?.prompts).toEqual(["Hello", "Again"]));
    sessions.get("one")?.finishPrompt();
    await again;
    expect(sessions.size).toBe(1);
    await agent.dispose();
    expect(sessions.get("one")?.disposeCount).toBe(1);
  });

  it("still rejects an unusable model when it is applied, before any session opens", async () => {
    const sessions = new Map<string, MockPiSession>();
    const factory = factoryFor(sessions);
    factory.resolveModel = () => {
      throw Object.assign(new Error("no key"), { code: "configuration_required" });
    };
    const agent = new WispConversationAgent(context("one"), factory);
    await agent.start();

    await expect(agent.applyModel(selection())).rejects.toMatchObject({ code: "configuration_required" });
    await expect(agent.send({ conversationId: "one", requestId: "r1", text: "Hello" })).rejects.toMatchObject({
      code: "configuration_required",
    });
    expect(sessions.size).toBe(0);
    await agent.dispose();
  });
});

it("reports the model actually used while an override waits for the active turn", async () => {
  const sessions = new Map<string, MockPiSession>();
  const agent = new WispConversationAgent(context("one"), factoryFor(sessions));
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

it("opens the session at the chosen thinking level and changes it with the model", async () => {
  const sessions = new Map<string, MockPiSession>();
  const created: ModelSelection[] = [];
  const factory = factoryFor(sessions);
  const agent = new WispConversationAgent(context("one"), {
    ...factory,
    create: async (agentContext, chosen) => {
      created.push(chosen);
      return factory.create(agentContext, chosen);
    },
  });
  await agent.start();
  await agent.applyModel({ ...selection(), thinkingLevel: "high" });
  const first = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
  await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
  expect(created).toEqual([{ ...selection(), thinkingLevel: "high" }]);

  // A change during a turn waits for it, like a model change.
  await agent.applyModel(selection());
  expect(sessions.get("one")?.thinkingLevels).toEqual([]);
  sessions.get("one")?.finishPrompt();
  await first;
  await vi.waitFor(() => expect(sessions.get("one")?.thinkingLevels).toEqual(["off"]));

  await agent.applyModel({ ...selection(), thinkingLevel: "low" });
  expect(sessions.get("one")?.thinkingLevels).toEqual(["off", "low"]);
  await agent.dispose();
});

it("rebuilds the session at the next message when the tool snapshot changes, preserving identity", async () => {
  const created: MockPiSession[] = [];
  // The fetch after the first session opens returns a changed revision, forcing one rebuild.
  const factory = rebuildingFactory(created, ["rev-1", "rev-2", "rev-2"]);
  const agentContext = context("one");
  const agent = new WispConversationAgent(agentContext, factory, { flushDelayMs: 0 });
  const events = vi.fn();
  agent.subscribe(events);
  await agent.start();
  await agent.applyModel(selection());
  const first = agent.send({ conversationId: "one", requestId: "r0", text: "First" });
  await vi.waitFor(() => expect(created[0]?.prompts).toEqual(["First"]));
  created[0]?.finishPrompt();
  await first;

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
  const agent = new WispConversationAgent(agentContext, factory, { flushDelayMs: 0 });
  await agent.start();
  await agent.applyModel(selection());

  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
  await vi.waitFor(() => expect(created[0]?.prompts).toEqual(["Hello"]));
  created[0]?.finishPrompt();
  await send;

  expect(created).toHaveLength(1);
  await agent.dispose();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

it("cancels a message whose session is still opening instead of sending it", async () => {
  const sessions = new Map<string, MockPiSession>();
  const opening = deferred();
  const factory = factoryFor(sessions);
  const create = factory.create;
  factory.create = async (...args) => {
    await opening.promise;
    return create(...args);
  };
  const agent = new WispConversationAgent(context("one"), factory, { flushDelayMs: 0 });
  const events = vi.fn();
  agent.subscribe(events);
  await agent.start();
  await agent.applyModel(selection());

  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Never mind" });
  await agent.abort();
  opening.resolve();
  await send;

  expect(sessions.get("one")?.prompts).toEqual([]);
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({ type: "assistant_message_cancelled", requestId: "r1" }),
  );
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "conversation_error" }));
  await agent.dispose();
});

/** A session whose prompt first renews context (idle, like Pi's compaction) before the model run. */
class RenewingPiSession extends MockPiSession {
  readonly renewal = deferred();
  renewalAborted = false;

  override async prompt(text: string, options?: { signal?: AbortSignal }): Promise<void> {
    await this.renewal.promise;
    options?.signal?.throwIfAborted();
    return super.prompt(text);
  }

  override async abort(): Promise<void> {
    if (this.isIdle) {
      this.renewalAborted = true;
      this.renewal.resolve();
      return;
    }
    return super.abort();
  }
}

it("stops a context renewal that runs before the prompt and reports a cancellation", async () => {
  const session = new RenewingPiSession("one");
  const factory: RuntimeSessionFactory = { ...factoryFor(new Map()), create: async () => session };
  const agent = new WispConversationAgent(context("one"), factory, { flushDelayMs: 0 });
  const events = vi.fn();
  agent.subscribe(events);
  await agent.start();
  await agent.applyModel(selection());
  const first = agent.send({ conversationId: "one", requestId: "r0", text: "Open the session" });
  session.renewal.resolve();
  await vi.waitFor(() => expect(session.prompts).toEqual(["Open the session"]));
  session.finishPrompt();
  await first;
  Object.assign(session, { renewal: deferred() });

  const send = agent.send({ conversationId: "one", requestId: "r1", text: "Stop me" });
  await agent.abort();
  await send;

  expect(session.renewalAborted).toBe(true);
  expect(session.prompts).toEqual(["Open the session"]);
  expect(events).toHaveBeenCalledWith(
    expect.objectContaining({ type: "assistant_message_cancelled", requestId: "r1" }),
  );
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "conversation_error", requestId: "r1" }));
  await agent.dispose();
});

it("tells the model when a message was scheduled, without changing what the user wrote", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00.000Z") });
  try {
    const sessions = new Map<string, MockPiSession>();
    const agent = new WispConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0 });
    await agent.start();
    await agent.applyModel(selection());
    const send = agent.send({
      conversationId: "one",
      requestId: "r1",
      text: "Summarize the news",
      scheduled: {
        scheduledMessageId: "scheduled-1",
        scheduledAt: "2026-10-06T21:00:00.000Z",
        timeZone: "America/Sao_Paulo",
      },
    });
    await vi.waitFor(() => expect(sessions.get("one")?.prompts).toHaveLength(1));
    sessions.get("one")?.finishPrompt();
    await send;

    expect(sessions.get("one")?.prompts).toEqual([
      "[Sent automatically: the user wrote this message on Tue, Oct 6, 2026, 6:00 PM and scheduled it; it was sent on Wed, Oct 7, 2026, 9:00 AM (America/Sao_Paulo). They may not be present, so do what you can without waiting for their reply.]\n\nSummarize the news",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("tells the model the user's local time before each message they send", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00.000Z") });
  try {
    const sessions = new Map<string, MockPiSession>();
    let timeZone = "America/Sao_Paulo";
    const agent = new WispConversationAgent({ ...context("one"), userTimeZone: () => timeZone }, factoryFor(sessions), {
      flushDelayMs: 0,
    });
    await agent.start();
    await agent.applyModel(selection());
    const first = agent.send({ conversationId: "one", requestId: "r1", text: "What day is it?" });
    await vi.waitFor(() => expect(sessions.get("one")?.prompts).toHaveLength(1));
    sessions.get("one")?.finishPrompt();
    await first;
    timeZone = "Asia/Tokyo";
    const second = agent.send({ conversationId: "one", requestId: "r2", text: "And now?" });
    await vi.waitFor(() => expect(sessions.get("one")?.prompts).toHaveLength(2));
    sessions.get("one")?.finishPrompt();
    await second;

    expect(sessions.get("one")?.prompts).toEqual([
      "[Sent on Wed, Oct 7, 2026, 9:00 AM (America/Sao_Paulo)]\n\nWhat day is it?",
      "[Sent on Wed, Oct 7, 2026, 9:00 PM (Asia/Tokyo)]\n\nAnd now?",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

describe("WispConversationAgent runtime events", () => {
  it("records a Pi session's own events while its conversation records", async () => {
    const sessions = new Map<string, MockPiSession>();
    const runtimeEvents = new RuntimeEventLog();
    const agent = new WispConversationAgent(context("one"), factoryFor(sessions), { flushDelayMs: 0, runtimeEvents });
    await agent.start();
    await agent.applyModel(selection());

    const first = agent.send({ conversationId: "one", requestId: "r1", text: "Unrecorded" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
    sessions.get("one")?.finishPrompt();
    await first;
    expect(runtimeEvents.read("one").events).toEqual([]);

    runtimeEvents.setRecording("one", true);
    const second = agent.send({ conversationId: "one", requestId: "r2", text: "Recorded" });
    await vi.waitFor(() => expect(sessions.get("one")?.isIdle).toBe(false));
    sessions.get("one")?.finishPrompt();
    await second;

    const events = runtimeEvents.read("one").events;
    expect(events.map(({ type }) => type)).toEqual(["agent_start", "message_start", "message_update", "agent_settled"]);
    expect(events.every(({ runtime, wispId }) => runtime === "pi" && wispId === "one")).toBe(true);
    expect(events[2]?.payload).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "reply:Recorded" },
    });
    await agent.dispose();
  });

  it("records a runtime's raw events instead of their Pi shape when the session has them", async () => {
    class RawSession extends MockPiSession {
      private readonly rawListeners = new Set<(event: unknown) => void>();
      subscribeRuntimeEvents(listener: (event: unknown) => void): () => void {
        this.rawListeners.add(listener);
        return () => this.rawListeners.delete(listener);
      }
      override async prompt(text: string): Promise<void> {
        for (const listener of this.rawListeners) listener({ type: "stream_event", text });
        return super.prompt(text);
      }
    }
    const sessions: RawSession[] = [];
    const runtimeEvents = new RuntimeEventLog();
    runtimeEvents.setRecording("one", true);
    const factory: RuntimeSessionFactory = {
      ...factoryFor(new Map()),
      create: async (agentContext) => {
        const session = new RawSession(agentContext.conversationId);
        sessions.push(session);
        return session;
      },
    };
    const agent = new WispConversationAgent(context("one"), factory, { flushDelayMs: 0, runtimeEvents });
    await agent.start();
    await agent.applyModel(selection());
    const sent = agent.send({ conversationId: "one", requestId: "r1", text: "Hello" });
    await vi.waitFor(() => expect(sessions[0]?.isIdle).toBe(false));
    sessions[0]?.finishPrompt();
    await sent;

    expect(runtimeEvents.read("one").events).toMatchObject([
      { runtime: "claude-code", type: "stream_event", payload: { type: "stream_event", text: "Hello" } },
    ]);
    await agent.dispose();
  });
});
