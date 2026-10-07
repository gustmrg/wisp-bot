import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { AgentRegistry } from "../../backend/agent-registry.js";
import { ConversationRepository } from "../../backend/conversation-repository.js";
import { ConversationService } from "../../backend/conversation-service.js";
import { FakeConversationAgentFactory } from "../../backend/fake-conversation-agent.js";
import { MessageQueue } from "../../backend/message-queue.js";
import { MessageScheduler } from "../../backend/message-scheduler.js";
import type { ModelSelection } from "../../shared/contracts.js";
import type { Chat, Message } from "../../shared/conversations.js";
import type { MessageQueueView } from "../../shared/message-queue.js";
import type { ScheduledMessagesView } from "../../shared/scheduled-messages.js";

export const MODEL: ModelSelection = { providerId: "openai", modelId: "gpt-test" };
export const START = new Date("2026-10-06T12:00:00.000Z");

export function wisp(id: string): Chat {
  return {
    id,
    kind: "wisp",
    shape: "circle",
    name: id,
    label: "Test",
    description: "Test",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

/**
 * The conversation service, queue, and scheduler wired as `createBackendRuntime`
 * wires them, over a fake agent, with a clock the test moves. Use with fake
 * `setTimeout`/`clearTimeout`.
 */
export async function setupMessaging(
  options: { model?: ModelSelection | null; directory?: string; latencyMs?: number } = {},
) {
  const directory = options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-messaging-")));
  let now = START;
  let queue: MessageQueue | undefined;
  let scheduler: MessageScheduler | undefined;
  const repository = new ConversationRepository({ dataDirectory: directory });
  const registry = new AgentRegistry(
    new FakeConversationAgentFactory({ latencyMs: options.latencyMs ?? 0 }),
    (event) => service.handleAgentEvent(event),
    undefined,
    { onAvailable: (conversationId) => queue?.pump(conversationId) },
  );
  const removed = vi.fn();
  const service: ConversationService = new ConversationService(repository, registry, () => [], {
    onConversationsRemoved: () => {
      removed();
      scheduler?.refresh();
      queue?.refresh();
    },
  });
  await service.start(options.model === undefined ? MODEL : options.model);
  if (!repository.isInitialized()) await service.initialize({ one: wisp("one") });
  const queueViews: MessageQueueView[] = [];
  const scheduleViews: ScheduledMessagesView[] = [];
  let queueIds = 0;
  queue = new MessageQueue({
    repository,
    isAvailable: (conversationId) => registry.isAvailable(conversationId),
    deliverNext: (conversationId, onTaken) => service.deliverNextQueued(conversationId, onTaken),
    onChanged: (view) => queueViews.push(view),
    now: () => now,
    createId: () => `queued-${(queueIds += 1)}`,
  });
  let scheduleIds = 0;
  scheduler = new MessageScheduler({
    repository,
    send: async (conversationId, text, scheduled) => {
      await queue?.enqueue(conversationId, text, { scheduled });
    },
    onChanged: (view) => scheduleViews.push(view),
    now: () => now,
    createId: () => `scheduled-${(scheduleIds += 1)}`,
  });
  const messageQueue = queue;
  const messageScheduler = scheduler;
  return {
    directory,
    repository,
    registry,
    service,
    queue: messageQueue,
    scheduler: messageScheduler,
    queueViews,
    scheduleViews,
    removed,
    transcript: async (conversationId = "one"): Promise<ReadonlyArray<Message>> =>
      (await service.getMessagePage({ conversationId, page: "latest" })).messages,
    /** Moves the clock and lets the timers that came due run. */
    advance: async (ms: number) => {
      now = new Date(now.getTime() + ms);
      await vi.advanceTimersByTimeAsync(ms);
    },
    close: async () => {
      await messageScheduler.dispose();
      messageQueue.dispose();
      await service.dispose();
      await repository.close();
    },
  };
}
