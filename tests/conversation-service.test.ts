import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../backend/conversation-agent.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { ConversationService } from "../backend/conversation-service.js";
import { FakeConversationAgent, FakeConversationAgentFactory } from "../backend/fake-conversation-agent.js";
import type { Chat } from "../shared/conversations.js";

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
