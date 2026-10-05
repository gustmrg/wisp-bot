import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../backend/conversation-agent.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { ConversationService } from "../backend/conversation-service.js";
import { FakeConversationAgent, FakeConversationAgentFactory } from "../backend/fake-conversation-agent.js";
import type { SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { Chat, ConversationDelta } from "../shared/conversations.js";

function chat(id: string, circle = false): Chat {
  const base = {
    id,
    name: id,
    label: "Test",
    description: "Test",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
  return circle ? { ...base, kind: "circle", memberIds: [] } : { ...base, kind: "wisp", shape: "circle" };
}

describe("ConversationService", () => {
  it("keeps one managed agent per Wisp and disposes it before archiving its workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-"));
    const disposedWithWorkspace: string[] = [];
    const factory: ConversationAgentFactory = {
      create: (context: ConversationAgentContext) => {
        const agent = new FakeConversationAgent(context.conversationId);
        const originalDispose = agent.dispose.bind(agent);
        agent.dispose = async () => {
          await access(context.workspaceDirectory);
          disposedWithWorkspace.push(context.conversationId);
          await originalDispose();
        };
        return agent;
      },
    };
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(factory, () => undefined);
    const service = new ConversationService(repository, registry);
    await service.start(null);

    const initialized = await service.initialize({ one: chat("one"), circle: chat("circle", true) });
    expect(registry.list()).toEqual(["one"]);
    expect(initialized.statuses).toEqual({ one: "configuration_required" });

    await service.create(chat("two"));
    expect(registry.list().sort()).toEqual(["one", "two"]);
    await service.delete("two");

    expect(disposedWithWorkspace).toContain("two");
    expect(registry.list()).toEqual(["one"]);
    await service.dispose();
  });

  it("applies updated Wisp identity to the running agent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-context-"));
    const updateContext = vi.fn(async () => undefined);
    const factory: ConversationAgentFactory = {
      create: (context) => {
        const agent = new FakeConversationAgent(context.conversationId);
        agent.updateContext = updateContext;
        return agent;
      },
    };
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(factory, () => undefined);
    const service = new ConversationService(repository, registry);
    await service.start(null);
    await service.initialize({ one: chat("one") });

    await service.update("one", { kind: "wisp", description: "Financial advisor" });

    expect(updateContext).toHaveBeenCalledWith(expect.objectContaining({ description: "Financial advisor" }));
    await service.dispose();
  });

  it("refreshes every existing Wisp when the shared profile changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-profile-"));
    const updateContext = vi.fn(async () => undefined);
    const registry = new AgentRegistry(
      {
        create: (context) => {
          const agent = new FakeConversationAgent(context.conversationId);
          agent.updateContext = updateContext;
          return agent;
        },
      },
      () => undefined,
    );
    const service = new ConversationService(new ConversationRepository({ dataDirectory: directory }), registry);
    await service.start(null);
    await service.initialize({ one: chat("one"), two: chat("two"), circle: chat("circle", true) });
    const profile = { preferredName: "Ada", aboutYou: "Developer", responsePreferences: "Be concise" };
    await service.saveUserProfile(profile);
    expect(service.getUserProfile()).toEqual(profile);
    expect(updateContext).toHaveBeenCalledTimes(2);
    for (const conversationId of ["one", "two"]) {
      expect(updateContext).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId, userName: "Ada", userProfile: profile }),
      );
    }
    await service.dispose();
  });

  it("applies a creation-time model override and restores it after a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-create-model-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    const service = new ConversationService(repository, registry);
    const globalModel = { providerId: "global", modelId: "global-model" };
    await service.start(globalModel);
    await service.initialize({ follower: chat("follower") });

    const override = { providerId: "other", modelId: "other-model", maxOutputTokens: 2048 };
    await service.create(chat("custom"), override);

    expect(service.getConversationModel("custom")).toEqual(
      expect.objectContaining({ override, effective: override, applied: override, status: "idle" }),
    );
    expect(service.getConversationModel("follower").applied).toEqual(globalModel);
    await service.dispose();

    const restoredRegistry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    const restored = new ConversationService(repository, restoredRegistry);
    await restored.start(globalModel);
    expect(restored.getConversationModel("custom").applied).toEqual(override);
    expect(restored.getConversationModel("follower").applied).toEqual(globalModel);
    await restored.dispose();
  });

  it("snapshots and persists isolated streams from the deterministic fake adapter", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-stream-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    let service: ConversationService;
    const registry = new AgentRegistry(
      new FakeConversationAgentFactory({
        latencyMs: 100,
        responseFor: ({ text }) => `Reply:${text}`,
      }),
      (event) => service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry);
    await service.start({ providerId: "test", modelId: "test" });
    await service.initialize({ one: chat("one"), two: chat("two") });
    await Promise.all([
      service.appendMessage("one", { id: "one-a", type: "outgoing", text: "A", status: "queued" }),
      service.appendMessage("one", { id: "one-b", type: "outgoing", text: "B", status: "queued" }),
      service.appendMessage("two", { id: "two-a", type: "outgoing", text: "C", status: "queued" }),
    ]);

    registry.dispatch({ conversationId: "one", requestId: "one-a", text: "A" });
    registry.dispatch({ conversationId: "one", requestId: "one-b", text: "B" });
    registry.dispatch({ conversationId: "two", requestId: "two-a", text: "C" });

    await vi.waitFor(() => {
      const snapshot = service.getState();
      expect(snapshot.chats.one.messages).toContainEqual(
        expect.objectContaining({
          id: "one-a:assistant",
          status: "streaming",
        }),
      );
      expect(snapshot.agentEventSequence).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      const snapshot = service.getState();
      expect(snapshot.chats.one.messages).toContainEqual(
        expect.objectContaining({
          id: "one-a",
          status: "complete",
        }),
      );
      expect(snapshot.chats.one.messages.filter(({ type }) => type === "incoming")).toEqual([
        expect.objectContaining({
          id: "one-a:assistant",
          text: "Reply:A",
          status: "complete",
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
        expect.objectContaining({
          id: "one-b:assistant",
          text: "Reply:B",
          status: "complete",
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ]);
      expect(snapshot.chats.two.messages).toContainEqual(
        expect.objectContaining({
          id: "two-a:assistant",
          text: "Reply:C",
          status: "complete",
        }),
      );
    });
    await service.dispose();
  });

  it("pushes what changed after persisting agent-driven changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-push-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const onConversationChanged = vi.fn<(delta: ConversationDelta) => void>();
    let service: ConversationService;
    const registry = new AgentRegistry(
      new FakeConversationAgentFactory({ latencyMs: 10, responseFor: ({ text }) => `Reply:${text}` }),
      (event) => service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry, () => [], { onConversationChanged });
    await service.start({ providerId: "test", modelId: "test" });
    await service.initialize({ one: chat("one") });
    // A message the user writes is new the first time and an update after that.
    await expect(
      service.appendMessage("one", { id: "request-1", type: "outgoing", text: "A", status: "queued" }),
    ).resolves.toMatchObject({ chat: { id: "one", preview: "A" }, added: [{ id: "request-1" }], updated: [] });
    await expect(
      service.appendMessage("one", { id: "request-1", type: "outgoing", text: "A", status: "queued" }),
    ).resolves.toMatchObject({ added: [], updated: [{ id: "request-1" }] });

    registry.dispatch({ conversationId: "one", requestId: "request-1", text: "A" });

    await vi.waitFor(() =>
      expect(onConversationChanged).toHaveBeenLastCalledWith({
        chat: expect.objectContaining({ id: "one", preview: "Reply:A" }),
        added: [expect.objectContaining({ id: "request-1:assistant", text: "Reply:A", status: "complete" })],
        updated: [],
      }),
    );
    // The delivery status is an update to the user's message, and summaries never carry transcripts.
    expect(onConversationChanged).toHaveBeenCalledWith({
      chat: expect.objectContaining({ id: "one" }),
      added: [],
      updated: [expect.objectContaining({ id: "request-1", status: "complete" })],
    });
    for (const [delta] of onConversationChanged.mock.calls) expect(delta.chat).not.toHaveProperty("messages");
    expect(service.getState().liveMessages).toEqual({});
    await service.dispose();
  });

  it("shows a reply that is still streaming on the newest page only", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-pages-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    let service: ConversationService;
    const registry = new AgentRegistry(
      new FakeConversationAgentFactory({ latencyMs: 300, responseFor: () => "A long streamed reply" }),
      (event) => service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry);
    await service.start({ providerId: "test", modelId: "test" });
    const history = Array.from({ length: 60 }, (_, index) => ({
      id: `h${index}`,
      type: "incoming" as const,
      text: `${index}`,
    }));
    await service.initialize({ one: { ...chat("one"), messages: history } });
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "Go", status: "queued" });

    registry.dispatch({ conversationId: "one", requestId: "request-1", text: "Go" });
    await vi.waitFor(() =>
      expect(service.getState().chats.one?.messages.at(-1)).toMatchObject({
        id: "request-1:assistant",
        status: "streaming",
      }),
    );

    expect(service.getState().liveMessages.one).toEqual([
      expect.objectContaining({ id: "request-1:assistant", status: "streaming" }),
    ]);
    const latest = await service.getMessagePage({ conversationId: "one", page: "latest" });
    expect(latest.messages.at(-1)).toMatchObject({ id: "request-1:assistant", status: "streaming" });
    const older = await service.getMessagePage({ conversationId: "one", page: "older", cursor: latest.olderCursor! });
    expect(older.messages.map(({ id }) => id)).not.toContain("request-1:assistant");
    await service.dispose();
  });

  it("refuses to let a renderer write overwrite a reply", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-owned-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const service = new ConversationService(
      repository,
      new AgentRegistry(new FakeConversationAgentFactory(), () => undefined),
    );
    await service.start(null);
    await service.initialize({ one: chat("one") });
    await repository.appendMessage("one", { id: "request-1:assistant", type: "incoming", text: "Real reply" });

    await expect(
      service.appendMessage("one", { id: "request-1:assistant", type: "outgoing", text: "Forged" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.appendMessage("one", { id: "request-2", type: "outgoing", text: "Mine", status: "queued" }),
    ).resolves.toMatchObject({ chat: { preview: "Mine" } });
    expect(repository.getChats().one?.messages).toContainEqual(
      expect.objectContaining({ id: "request-1:assistant", text: "Real reply" }),
    );
    await service.dispose();
  });

  it("logs and surfaces a reply that could not be saved", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-persist-failure-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const published: SequencedConversationAgentEvent[] = [];
    const logger = { warn: vi.fn() };
    let service: ConversationService;
    const registry = new AgentRegistry(
      new FakeConversationAgentFactory({ latencyMs: 10, responseFor: () => "Lost reply" }),
      (event) => {
        published.push(event);
        service.handleAgentEvent(event);
      },
    );
    service = new ConversationService(repository, registry, () => [], { logger });
    await service.start({ providerId: "test", modelId: "test" });
    await service.initialize({ one: chat("one") });
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "A", status: "queued" });
    const append = repository.appendMessage.bind(repository);
    vi.spyOn(repository, "appendMessage").mockImplementation((conversationId, message) =>
      message.type === "incoming" ? Promise.reject(new Error("disk full")) : append(conversationId, message),
    );

    registry.dispatch({ conversationId: "one", requestId: "request-1", text: "A" });

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith("conversation_persist_failed", {
        conversationId: "one",
        messageId: "request-1:assistant",
        code: "internal_error",
      }),
    );
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        conversationId: "one",
        error: expect.objectContaining({ message: expect.stringMatching(/could not be saved/) }),
      }),
    );
    expect(published.find((event) => event.type === "conversation_error")).not.toHaveProperty("requestId");
    // Still visible until restart.
    expect(service.getState().chats.one?.messages).toContainEqual(
      expect.objectContaining({ id: "request-1:assistant", text: "Lost reply" }),
    );
    await service.dispose();
  });

  it("deletes a Wisp during active work without resurrecting its stream", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-delete-active-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    let service: ConversationService;
    const registry = new AgentRegistry(new FakeConversationAgentFactory({ latencyMs: 100 }), (event) =>
      service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry);
    await service.start(null);
    await service.initialize({ one: chat("one") });
    await service.applyModel({ providerId: "provider", modelId: "model" });
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "Wait", status: "queued" });
    registry.dispatch({ conversationId: "one", requestId: "request-1", text: "Wait" });
    await vi.waitFor(() => expect(service.getState().statuses.one).toBe("working"));

    await service.delete("one");

    expect(registry.has("one")).toBe(false);
    expect(service.getState().chats.one).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(service.getState().chats.one).toBeUndefined();
    await service.dispose();
  });
});

it("persists a Wisp override across restart without changing the global model or other Wisps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-model-override-"));
  const global = { providerId: "provider-a", modelId: "default" };
  const override = { providerId: "provider-b", modelId: "custom", maxOutputTokens: 512 };
  const makeService = () => {
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    return new ConversationService(repository, registry);
  };
  const first = makeService();
  await first.start(global);
  await first.initialize({ one: chat("one"), two: chat("two"), circle: chat("circle", true) });
  await first.applyConversationModel("one", override);
  expect(first.getConversationModel("one")).toMatchObject({ override, applied: override });
  expect(first.getConversationModel("two").effective).toEqual(global);
  await expect(first.applyConversationModel("circle", override)).rejects.toMatchObject({ code: "invalid_request" });
  await first.dispose();
  const restarted = makeService();
  await restarted.start(global);
  expect(restarted.getConversationModel("one")).toMatchObject({ override, applied: override });
  await restarted.applyConversationModel("one", null);
  expect(restarted.getConversationModel("one")).toMatchObject({ override: null, applied: global });
  await restarted.dispose();
  const inherited = makeService();
  await inherited.start(global);
  expect(inherited.getConversationModel("one").override).toBeNull();
  await inherited.dispose();
});
