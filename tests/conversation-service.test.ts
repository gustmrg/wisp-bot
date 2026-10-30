import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../backend/agent-registry.js";
import { WispBackendError } from "../backend/backend-error.js";
import { CircleAgentFactory } from "../backend/circle-conversation-agent.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../backend/conversation-agent.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { ConversationService } from "../backend/conversation-service.js";
import { seedConversations } from "./helpers/seed-conversations.js";
import { FakeConversationAgent, FakeConversationAgentFactory } from "../backend/fake-conversation-agent.js";
import { PiEventTranslator } from "../backend/pi-event-translator.js";
import type { SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { Chat, CircleChat, ConversationDelta, Wisp, WispsView } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

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
  return circle ? { ...base, kind: "circle", memberIds: [] } : { ...base, kind: "wisp" };
}

function newWisp(id: string): Wisp {
  return { id, name: id, role: "Test", soul: "Test", appearance: DEFAULT_WISP_APPEARANCE };
}

describe("ConversationService with a decision model", () => {
  it("stores that the chosen member's reply was chosen, and tells the circle when the choice changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-chosen-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const members: ConversationAgentFactory = {
      create: (context) =>
        new FakeConversationAgent(context.conversationId, { responseFor: () => `${context.name} here` }),
    };
    const chooseResponder = vi.fn(async () => "nova");
    let service!: ConversationService;
    const registry = new AgentRegistry(
      new CircleAgentFactory(members, {
        readTranscript: (conversationId) => service.getMessagePage({ conversationId, page: "latest" }),
        chooseResponder,
      }),
      (event) => service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry);
    await service.start({ providerId: "test", modelId: "test" });
    await seedConversations(repository, { atlas: chat("atlas"), nova: chat("nova") }).then(() => service.initialize());
    await service.create({ ...(chat("crew", true) as CircleChat), memberIds: ["atlas", "nova"] });

    await service.appendMessage("crew", { id: "m1", type: "outgoing", text: "First", status: "queued" });
    await registry.dispatch({ conversationId: "crew", requestId: "m1", text: "First" });
    expect(chooseResponder).not.toHaveBeenCalled();

    await service.update("crew", { kind: "circle", responder: "auto" });
    await service.appendMessage("crew", { id: "m2", type: "outgoing", text: "Second", status: "queued" });
    await registry.dispatch({ conversationId: "crew", requestId: "m2", text: "Second" });
    await service.appendMessage("crew", { id: "m3", type: "outgoing", text: "@atlas third", status: "queued" });
    await registry.dispatch({ conversationId: "crew", requestId: "m3", text: "@atlas third" });

    const { messages } = await service.getMessagePage({ conversationId: "crew", page: "latest" });
    expect(messages.find(({ id }) => id === "m1:atlas:assistant")).not.toHaveProperty("chosenAutomatically");
    expect(messages.find(({ id }) => id === "m2:nova:assistant")).toMatchObject({
      status: "complete",
      chosenAutomatically: true,
    });
    expect(messages.find(({ id }) => id === "m3:atlas:assistant")).not.toHaveProperty("chosenAutomatically");
    expect(chooseResponder).toHaveBeenCalledOnce();
    await service.dispose();
  });
});

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

    const initialized = await seedConversations(repository, { one: chat("one"), circle: chat("circle", true) }).then(
      () => service.initialize(),
    );
    // A circle's agent is its members' (ADR 011).
    expect(registry.list()).toEqual(["one", "circle"]);
    expect(initialized.statuses).toEqual({ one: "configuration_required", circle: "configuration_required" });

    const created = await service.createWisp(newWisp("two"), { notifyOnUpdatesEnabled: true });
    expect(created.wisps.two).toEqual(newWisp("two"));
    expect(created.chats.two).toMatchObject({ kind: "wisp", wispId: "two" });
    expect(registry.list().sort()).toEqual(["circle", "one", "two"]);
    const deleted = await service.deleteWisp("two");
    expect(deleted.wisps).not.toHaveProperty("two");
    expect(deleted.chats).not.toHaveProperty("two");

    expect(disposedWithWorkspace).toContain("two");
    expect(registry.list()).toEqual(["one", "circle"]);
    await service.dispose();
  });

  it("cleans up outside Wisp's data only once a Wisp is deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-cleanup-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    const cleanup = vi.fn(() => expect(registry.list()).toEqual([]));
    const onSessionsEnding = vi.fn(async () => cleanup);
    const service = new ConversationService(repository, registry, () => [], { onSessionsEnding });
    await service.start(null);
    await service.initialize();
    await service.createWisp(newWisp("two"), { notifyOnUpdatesEnabled: true });
    const context = repository.getAgentContext("two");

    await service.deleteWisp("two");

    expect(onSessionsEnding).toHaveBeenCalledWith({
      workspaces: [{ workspaceDirectory: context.workspaceDirectory, sessionDirectories: [context.sessionDirectory] }],
      sessions: [],
    });
    expect(cleanup).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("tells every device when a Wisp is created, changed or deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-wisps-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    const onWispsChanged = vi.fn<(view: WispsView) => void>();
    const service = new ConversationService(repository, registry, () => [], { onWispsChanged });
    await service.start(null);
    await service.initialize();

    await service.createWisp(newWisp("two"), { notifyOnUpdatesEnabled: true });
    expect(onWispsChanged).toHaveBeenLastCalledWith({
      wisps: { two: newWisp("two") },
      chats: { two: expect.objectContaining({ kind: "wisp", wispId: "two" }) },
      statuses: { two: "configuration_required" },
    });
    expect(onWispsChanged.mock.lastCall![0].chats.two).not.toHaveProperty("messages");
    await service.updateWisp("two", { role: "Writing" });
    expect(onWispsChanged.mock.lastCall![0].wisps.two).toMatchObject({ role: "Writing" });
    await service.deleteWisp("two");
    expect(onWispsChanged).toHaveBeenLastCalledWith({ wisps: {}, chats: {}, statuses: {} });
    expect(onWispsChanged).toHaveBeenCalledTimes(3);
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
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());

    const state = await service.updateWisp("one", { soul: "# Identity\nFinancial advisor" });

    expect(state.wisps.one?.soul).toBe("# Identity\nFinancial advisor");
    expect(updateContext).toHaveBeenCalledWith(expect.objectContaining({ soul: "# Identity\nFinancial advisor" }));
    updateContext.mockClear();
    await service.updateWisp("one", { color: "#123456" });
    await service.update("one", { kind: "wisp", notifyOnUpdatesEnabled: false });
    // Appearance and notifications do not change what the agent is told.
    expect(updateContext).not.toHaveBeenCalled();

    // Memory does: the agent loses it from the next message, and gets it back the same way (SWE-228).
    await service.updateWisp("one", { memoryOff: true });
    expect(updateContext).toHaveBeenLastCalledWith(expect.objectContaining({ memoryOff: true }));
    expect(updateContext).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ memory: expect.anything() }) as unknown as ConversationAgentContext,
    );
    await service.updateWisp("one", { memoryOff: false });
    expect(updateContext).toHaveBeenLastCalledWith(expect.objectContaining({ memory: expect.anything() }));
    expect(updateContext).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ memoryOff: true }) as unknown as ConversationAgentContext,
    );
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
    const repository = new ConversationRepository({ dataDirectory: directory });
    const service = new ConversationService(repository, registry);
    await service.start(null);
    await seedConversations(repository, { one: chat("one"), two: chat("two"), circle: chat("circle", true) }).then(() =>
      service.initialize(),
    );
    const profile = { preferredName: "Ada" };
    await service.saveUserProfile(profile);
    expect(service.getUserProfile()).toEqual(profile);
    // The circle's agent too, which names the person to its members.
    expect(updateContext).toHaveBeenCalledTimes(3);
    expect(updateContext).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "circle", conversationId: "circle", userName: "Ada" }),
    );
    for (const conversationId of ["one", "two"]) {
      expect(updateContext).toHaveBeenCalledWith(expect.objectContaining({ conversationId, userName: "Ada" }));
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
    await seedConversations(repository, { follower: chat("follower") }).then(() => service.initialize());

    const override = { providerId: "other", modelId: "other-model", maxOutputTokens: 2048 };
    await service.createWisp(newWisp("custom"), { notifyOnUpdatesEnabled: true, model: override });

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
    await seedConversations(repository, { one: chat("one"), two: chat("two") }).then(() => service.initialize());
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
          authorId: "one",
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

  it("answers in a circle with its members, each reply theirs, and fails only a member that fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-circle-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    let service: ConversationService;
    const members = new FakeConversationAgentFactory({ responseFor: ({ text }) => `Reply:${text.slice(-5)}` });
    const registry = new AgentRegistry(
      new CircleAgentFactory(
        {
          create: (context) => {
            const agent = members.create(context);
            // Nova has no model to answer with.
            if (context.wispId === "nova") {
              agent.send = async () => {
                throw new WispBackendError("configuration_required", "Choose a model for Nova.");
              };
            }
            return agent;
          },
        },
        { readTranscript: (conversationId) => service.getMessagePage({ conversationId, page: "latest" }) },
      ),
      (event) => service.handleAgentEvent(event),
    );
    service = new ConversationService(repository, registry);
    await service.start({ providerId: "test", modelId: "test" });
    await seedConversations(repository, { atlas: chat("atlas"), nova: chat("nova") }).then(() => service.initialize());
    const created = await service.create({ ...(chat("crew", true) as CircleChat), memberIds: ["atlas", "nova"] });
    expect(created.statuses.crew).toBe("idle");

    await service.appendMessage("crew", { id: "m1", type: "outgoing", text: "@nova @atlas hello", status: "queued" });
    await registry.dispatch({ conversationId: "crew", requestId: "m1", text: "@nova @atlas hello" });

    await vi.waitFor(async () => {
      const { messages } = await service.getMessagePage({ conversationId: "crew", page: "latest" });
      expect(messages).toEqual([
        expect.objectContaining({ id: "m1", type: "outgoing", status: "complete" }),
        expect.objectContaining({
          id: "m1:nova:assistant",
          status: "failed",
          authorId: "nova",
          authorName: "nova",
          retryable: false,
          error: { code: "configuration_required", message: "Choose a model for Nova." },
        }),
        expect.objectContaining({
          id: "m1:atlas:assistant",
          status: "complete",
          authorId: "atlas",
          authorName: "atlas",
          // Nova said nothing, so Atlas reads the message alone.
          text: "Reply:hello",
        }),
      ]);
    });
    // A deleted member's replies stay in the circle, still named.
    await service.deleteWisp("atlas");
    const { messages } = await service.getMessagePage({ conversationId: "crew", page: "latest" });
    expect(messages).toContainEqual(
      expect.objectContaining({ id: "m1:atlas:assistant", authorId: "atlas", authorName: "atlas" }),
    );
    await service.dispose();
  });

  it("follows a circle's members, and ends the sessions of those who leave it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-circle-members-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
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
    const ended = vi.fn();
    const onSessionsEnding = vi.fn(async () => ended);
    const service = new ConversationService(repository, registry, () => [], { onSessionsEnding });
    await service.start(null);
    await seedConversations(repository, { atlas: chat("atlas"), nova: chat("nova") }).then(() => service.initialize());
    await service.create({ ...(chat("crew", true) as CircleChat), memberIds: ["atlas", "nova"] });
    const nova = repository.getCircleAgentContext("crew").members[1]!;

    await service.update("crew", { kind: "circle", memberIds: ["atlas"] });

    expect(onSessionsEnding).toHaveBeenCalledWith({
      workspaces: [],
      sessions: [{ workspaceDirectory: nova.workspaceDirectory, sessionDirectory: nova.sessionDirectory }],
    });
    expect(ended).toHaveBeenCalledOnce();
    expect(updateContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "circle", members: [expect.objectContaining({ wispId: "atlas" })] }),
    );
    updateContext.mockClear();
    await service.updateWisp("atlas", { name: "Atlas Prime" });
    expect(updateContext).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "circle",
        members: [expect.objectContaining({ name: "Atlas Prime", circle: expect.anything() })],
      }),
    );

    onSessionsEnding.mockClear();
    const atlas = repository.getCircleAgentContext("crew").members[0]!;
    await service.delete("crew");
    expect(onSessionsEnding).toHaveBeenCalledWith({
      workspaces: [{ workspaceDirectory: atlas.workspaceDirectory, sessionDirectories: [atlas.sessionDirectory] }],
      sessions: [],
    });
    expect(registry.list().sort()).toEqual(["atlas", "nova"]);
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
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());
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
    await seedConversations(repository, { one: { ...chat("one"), messages: history } }).then(() =>
      service.initialize(),
    );
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
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());
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
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());
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

  it("keeps why a reply failed apart from its text, across a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-failure-reason-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    const service = new ConversationService(repository, registry);
    await service.start({ providerId: "test", modelId: "test" });
    await seedConversations(repository, { one: chat("one"), two: chat("two") }).then(() => service.initialize());
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "A", status: "queued" });
    await service.appendMessage("two", { id: "request-2", type: "outgoing", text: "B", status: "queued" });
    const error = { code: "model_unavailable", message: "The provider is out of credits.", retryable: false } as const;
    const events = [
      {
        type: "assistant_message_started",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
        createdAt: "2026-10-15T12:00:00.000Z",
      },
      {
        type: "assistant_text_delta",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
        delta: "Partial",
      },
      { type: "conversation_error", conversationId: "one", requestId: "request-1", error: { ...error, detail: "raw" } },
      { type: "conversation_error", conversationId: "two", requestId: "request-2", error },
    ] as const;
    events.forEach((event, index) => service.handleAgentEvent({ ...event, sequence: index + 1 }));
    await vi.waitFor(() =>
      expect(service.getState().chats.two?.messages).toContainEqual(
        expect.objectContaining({ id: "request-2:assistant", status: "failed" }),
      ),
    );
    await service.dispose();

    const restoredRepository = new ConversationRepository({ dataDirectory: directory });
    const restored = new ConversationService(
      restoredRepository,
      new AgentRegistry(new FakeConversationAgentFactory(), () => undefined),
    );
    await restored.start({ providerId: "test", modelId: "test" });
    await restored.initialize();
    const failure = { code: "model_unavailable", message: "The provider is out of credits." };
    const { chats } = restored.getState();
    expect(chats.one?.messages).toContainEqual(
      expect.objectContaining({ id: "request-1:assistant", status: "failed", text: "Partial", error: failure }),
    );
    expect(chats.two?.messages).toContainEqual(
      expect.objectContaining({ id: "request-2:assistant", status: "failed", text: "", error: failure }),
    );
    // A reply that failed before writing anything previews why.
    expect(chats.two?.preview).toBe("The provider is out of credits.");
    await restored.dispose();
  });

  it("stores the steps of a reply between its parts, without counting them as news", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-steps-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const service = new ConversationService(
      repository,
      new AgentRegistry(new FakeConversationAgentFactory(), () => undefined),
    );
    await service.start({ providerId: "test", modelId: "test" });
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "Fix it", status: "queued" });
    let sequence = 0;
    const translator = new PiEventTranslator(
      "one",
      (event) => service.handleAgentEvent({ ...event, sequence: ++sequence }),
      0,
      "/workspace",
    );
    const text = (delta: string) =>
      translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    translator.begin({ conversationId: "one", requestId: "request-1", text: "Fix it" });
    translator.handle({ type: "agent_start" });
    translator.handle({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
    translator.handle({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
    text("Found it.");
    translator.handle({
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "run_command",
      args: { command: "npm test" },
    });
    // The reply writes on before the command's end arrives; the stored step is updated in place.
    text("Running the tests.");
    translator.handle({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "run_command",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details: { commandResult: { exitCode: 0 } } },
    });
    translator.handle({ type: "agent_settled" });

    await vi.waitFor(() =>
      expect(service.getState().chats.one?.messages.at(-1)).toMatchObject({
        id: "request-1:assistant:2",
        status: "complete",
      }),
    );
    await vi.waitFor(() => expect(service.getState().liveMessages).toEqual({}));
    await service.dispose();

    const restored = new ConversationService(
      new ConversationRepository({ dataDirectory: directory }),
      new AgentRegistry(new FakeConversationAgentFactory(), () => undefined),
    );
    await restored.start({ providerId: "test", modelId: "test" });
    await restored.initialize();
    const one = restored.getState().chats.one!;
    expect(one.messages.map((message) => [message.id, message.type === "incoming" ? message.text : ""])).toEqual([
      ["request-1", ""],
      ["request-1:work", ""],
      ["request-1:assistant", "Found it."],
      ["request-1:work:2", ""],
      ["request-1:assistant:2", "Running the tests."],
    ]);
    expect(one.messages[1]).toMatchObject({
      type: "incoming",
      status: "complete",
      steps: [{ id: "a", type: "file_read", paths: ["a.ts"], status: "completed" }],
    });
    expect(one.messages[3]).toMatchObject({
      steps: [{ id: "b", type: "command_execution", command: "npm test", exitCode: 0, status: "completed" }],
    });
    // Only the reply's two parts are news, and the preview is its text.
    expect(one).toMatchObject({ preview: "Running the tests.", unreadCount: 2 });
    await restored.dispose();
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
    await seedConversations(repository, { one: chat("one") }).then(() => service.initialize());
    await service.applyModel({ providerId: "provider", modelId: "model" });
    await service.appendMessage("one", { id: "request-1", type: "outgoing", text: "Wait", status: "queued" });
    registry.dispatch({ conversationId: "one", requestId: "request-1", text: "Wait" });
    await vi.waitFor(() => expect(service.getState().statuses.one).toBe("working"));

    await service.deleteWisp("one");

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
  let repository = new ConversationRepository({ dataDirectory: directory });
  const makeService = () => {
    repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    return new ConversationService(repository, registry);
  };
  const first = makeService();
  await first.start(global);
  await seedConversations(repository, { one: chat("one"), two: chat("two"), circle: chat("circle", true) }).then(() =>
    first.initialize(),
  );
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

it("persists a Wisp's fallback choice across restart, and the fallback badge on the replies it wrote", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-fallback-"));
  const global = { providerId: "provider-a", modelId: "default" };
  const backup = { providerId: "provider-b", modelId: "backup" };
  let repository = new ConversationRepository({ dataDirectory: directory });
  const makeService = () => {
    repository = new ConversationRepository({ dataDirectory: directory });
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
    return new ConversationService(repository, registry);
  };
  const first = makeService();
  await first.start(global);
  await seedConversations(repository, { one: chat("one"), two: chat("two") }).then(() => first.initialize());
  await first.applyConversationFallback("one", backup);
  expect(first.getConversationModel("one").fallback).toEqual(backup);
  expect(first.getConversationModel("two").fallback).toBe("global");

  let sequence = 0;
  const handle = (event: Omit<SequencedConversationAgentEvent, "sequence">) =>
    first.handleAgentEvent({ ...event, sequence: ++sequence } as SequencedConversationAgentEvent);
  handle({
    type: "assistant_message_started",
    conversationId: "one",
    requestId: "request-1",
    messageId: "request-1:assistant",
    createdAt: "2026-10-15T12:00:00.000Z",
  });
  handle({
    type: "assistant_text_delta",
    conversationId: "one",
    requestId: "request-1",
    messageId: "request-1:assistant",
    delta: "Hi",
  });
  handle({
    type: "assistant_message_completed",
    conversationId: "one",
    requestId: "request-1",
    messageId: "request-1:assistant",
    fallbackModel: "Backup",
  });
  await vi.waitFor(() =>
    expect(first.getState().chats.one?.messages).toContainEqual(
      expect.objectContaining({ id: "request-1:assistant", text: "Hi", fallbackModel: "Backup" }),
    ),
  );
  await first.dispose();

  const restarted = makeService();
  await restarted.start(global);
  expect(restarted.getConversationModel("one").fallback).toEqual(backup);
  expect((await restarted.getMessagePage({ conversationId: "one", page: "latest" })).messages).toContainEqual(
    expect.objectContaining({ id: "request-1:assistant", fallbackModel: "Backup" }),
  );
  await restarted.dispose();
});
