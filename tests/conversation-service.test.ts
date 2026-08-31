import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../electron/backend/agent-registry.js";
import type { ConversationAgentContext, ConversationAgentFactory } from "../electron/backend/conversation-agent.js";
import { ConversationRepository } from "../electron/backend/conversation-repository.js";
import { ConversationService } from "../electron/backend/conversation-service.js";
import { FakeConversationAgent } from "../electron/backend/fake-conversation-agent.js";
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
});
