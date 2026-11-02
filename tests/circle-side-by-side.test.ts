import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../backend/agent-registry.js";
import { CircleAgentFactory } from "../backend/circle-conversation-agent.js";
import type { ConversationAgentFactory } from "../backend/conversation-agent.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { ConversationService } from "../backend/conversation-service.js";
import { FakeConversationAgent } from "../backend/fake-conversation-agent.js";
import { MessageQueue } from "../backend/message-queue.js";
import type { CircleChat, Chat } from "../shared/conversations.js";
import { seedConversations } from "./helpers/seed-conversations.js";

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

/**
 * The registry, queue, and service wired as the runtime wires them, over
 * members that answer when the test says so.
 */
async function setup(options: { executionTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-side-by-side-"));
  const repository = new ConversationRepository({ dataDirectory: directory });
  const holds = new Map<string, Array<() => void>>();
  const members: ConversationAgentFactory = {
    create: (context) => {
      const agent = new FakeConversationAgent(context.conversationId, {
        latencyMs: 0,
        responseFor: ({ text }) => (text.includes("hand over") ? "@nova your turn" : `${context.name} answered`),
      });
      const send = agent.send.bind(agent);
      agent.send = async (request) => {
        await new Promise<void>((resolve) => {
          holds.set(context.wispId, [...(holds.get(context.wispId) ?? []), resolve]);
        });
        return send(request);
      };
      return agent;
    },
  };
  let service!: ConversationService;
  let queue: MessageQueue | undefined;
  const registry = new AgentRegistry(
    new CircleAgentFactory(members, {
      readTranscript: (conversationId) => service.getMessagePage({ conversationId, page: "latest" }),
    }),
    (event) => service.handleAgentEvent(event),
    undefined,
    {
      onAvailable: (conversationId) => queue?.pump(conversationId),
      ...(options.executionTimeoutMs ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
    },
  );
  service = new ConversationService(repository, registry);
  await service.start({ providerId: "test", modelId: "test" });
  await seedConversations(repository, { atlas: chat("atlas"), nova: chat("nova") }).then(() => service.initialize());
  await service.create({ ...(chat("crew", true) as CircleChat), memberIds: ["atlas", "nova"] });
  let ids = 0;
  queue = new MessageQueue({
    repository,
    isAvailable: (conversationId) => registry.isAvailable(conversationId),
    takesSideBySide: (conversationId) => registry.takesSideBySide(conversationId),
    deliverNext: (conversationId, onTaken) => service.deliverNextQueued(conversationId, onTaken),
    onChanged: () => undefined,
    createId: () => `q${(ids += 1)}`,
  });
  const waitingFor = async (wispId: string) =>
    vi.waitFor(() => expect(holds.get(wispId)?.length ?? 0).toBeGreaterThan(0));
  const finish = async (wispId: string) => {
    await waitingFor(wispId);
    holds.get(wispId)!.shift()!();
  };
  const replies = async () =>
    (await service.getMessagePage({ conversationId: "crew", page: "latest" })).messages.flatMap((message) =>
      message.type === "incoming" && message.status === "complete" ? [message.text] : [],
    );
  const waiting = async () => (await queue!.getView()).messages.map(({ text }) => text);
  return { queue, registry, service, finish, waitingFor, replies, waiting, holds };
}

describe("a circle's messages side by side", () => {
  it("answers a message to a free member while another works, and tells the circle when each ends", async () => {
    const { queue, registry, finish, waitingFor, replies, waiting } = await setup();

    await queue.enqueue("crew", "@nova push the branch");
    await waitingFor("nova");
    expect(registry.statuses().crew).toBe("working");

    await queue.enqueue("crew", "@atlas are you free?");
    await waitingFor("atlas");
    expect(await waiting()).toEqual([]);

    await finish("atlas");
    await vi.waitFor(async () => expect(await replies()).toEqual(["atlas answered"]));
    expect(registry.statuses().crew).toBe("working");

    await finish("nova");
    await vi.waitFor(async () => expect(await replies()).toEqual(["atlas answered", "nova answered"]));
    await vi.waitFor(() => expect(registry.statuses().crew).toBe("idle"));
  });

  it("keeps a message for a busy member in the queue, lets others pass it, and sends it once free", async () => {
    const { queue, finish, waitingFor, holds, replies, waiting } = await setup();

    await queue.enqueue("crew", "@nova first");
    await waitingFor("nova");
    await queue.enqueue("crew", "@nova second");
    await queue.enqueue("crew", "@atlas third");
    await waitingFor("atlas");
    await vi.waitFor(async () => expect(await waiting()).toEqual(["@nova second"]));
    expect(holds.get("nova")).toHaveLength(1);

    await finish("nova");
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
    await finish("nova");
    await finish("atlas");
    await vi.waitFor(async () =>
      expect((await replies()).sort()).toEqual(["atlas answered", "nova answered", "nova answered"]),
    );
  });

  it("takes a waiting message as soon as a member hands its task over, with the handoff still running", async () => {
    const { queue, finish, waitingFor, holds, waiting } = await setup();

    await queue.enqueue("crew", "@atlas hand over");
    await waitingFor("atlas");
    await queue.enqueue("crew", "@atlas again");
    expect(await waiting()).toEqual(["@atlas again"]);

    await finish("atlas");
    await waitingFor("nova");
    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
    await waitingFor("atlas");
    expect(holds.get("nova")).toHaveLength(1);

    await finish("nova");
    await finish("atlas");
  });

  it("stops everything running on Stop, and goes on with what is queued", async () => {
    const { queue, registry, finish, waitingFor, holds, waiting } = await setup();

    await queue.enqueue("crew", "@nova first");
    await queue.enqueue("crew", "@atlas second");
    await waitingFor("nova");
    await waitingFor("atlas");
    await queue.enqueue("crew", "@nova third");
    expect(await waiting()).toEqual(["@nova third"]);

    await registry.abort("crew");
    await finish("nova");
    await finish("atlas");

    await vi.waitFor(async () => expect(await waiting()).toEqual([]));
    await waitingFor("nova");
    expect(holds.get("nova")).toHaveLength(1);
    await finish("nova");
    await vi.waitFor(() => expect(registry.statuses().crew).toBe("idle"));
  });

  it("times out only the message whose deadline passed", async () => {
    const { queue, service, registry, finish, waitingFor, replies } = await setup({ executionTimeoutMs: 150 });

    await queue.enqueue("crew", "@nova slow");
    await waitingFor("nova");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await queue.enqueue("crew", "@atlas quick");
    await waitingFor("atlas");
    await finish("atlas");
    await vi.waitFor(async () => expect(await replies()).toEqual(["atlas answered"]));

    await vi.waitFor(async () => {
      const { messages } = await service.getMessagePage({ conversationId: "crew", page: "latest" });
      expect(messages.find(({ id }) => id === "q1")).toMatchObject({ status: "failed" });
    });
    await finish("nova");
    await vi.waitFor(() => expect(registry.statuses().crew).toBe("idle"));
  });
});
