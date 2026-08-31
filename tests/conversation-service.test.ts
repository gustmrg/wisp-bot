import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../electron/backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../electron/backend/conversation-agent.js";
import { ConversationRepository } from "../electron/backend/conversation-repository.js";
import { ConversationService } from "../electron/backend/conversation-service.js";
import { FakeConversationAgent, FakeConversationAgentFactory } from "../electron/backend/fake-conversation-agent.js";
import type { Chat } from "../shared/conversations.js";

function chat(id: string, isCircle = false): Chat {
  return {
    id,
    name: id,
    label: "Test",
    description: "Test",
    shape: "circle",
    isCircle,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
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
    await service.start(null);
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
      expect(snapshot.chats.one.messages).toContainEqual(expect.objectContaining({
        id: "one-a:assistant",
        status: "streaming",
      }));
      expect(snapshot.agentEventSequence).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      const snapshot = service.getState();
      expect(snapshot.chats.one.messages).toContainEqual(expect.objectContaining({
        id: "one-a",
        status: "complete",
      }));
      expect(snapshot.chats.one.messages.filter(({ type }) => type === "incoming")).toEqual([
        expect.objectContaining({ id: "one-a:assistant", text: "Reply:A", status: "complete" }),
        expect.objectContaining({ id: "one-b:assistant", text: "Reply:B", status: "complete" }),
      ]);
      expect(snapshot.chats.two.messages).toContainEqual(expect.objectContaining({
        id: "two-a:assistant",
        text: "Reply:C",
        status: "complete",
      }));
    });
    await service.dispose();
  });

  it("deletes a Wisp during active work without resurrecting its stream", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-service-delete-active-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    let service: ConversationService;
    const registry = new AgentRegistry(
      new FakeConversationAgentFactory({ latencyMs: 100 }),
      (event) => service.handleAgentEvent(event),
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
