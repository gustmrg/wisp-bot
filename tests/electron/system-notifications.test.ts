import { describe, expect, it, vi } from "vitest";

import { registerSystemNotificationHandlers } from "../../electron/ipc/register-system-notification-handlers.js";
import {
  DEFAULT_SYSTEM_NOTIFICATION_SETTINGS,
  notificationBody,
  SystemNotifier,
  type SystemNotificationHost,
} from "../../electron/system-notifications.js";
import { WISP_IPC_CHANNELS, type ConversationAgentEvent } from "../../shared/contracts.js";
import type { ConnectionsView } from "../../shared/connections.js";
import type { ChatSummary, ConversationStateView } from "../../shared/conversations.js";
import type { ToolApprovalRequest } from "../../shared/tool-policy.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

function wispChat(id: string, overrides: Partial<ChatSummary> = {}) {
  return {
    id,
    kind: "wisp",
    wispId: id,
    notifyOnUpdatesEnabled: true,
    preview: "",
    messages: [],
    ...overrides,
  } as const;
}

function state(overrides: Partial<ConversationStateView> = {}): ConversationStateView {
  return {
    initialized: true,
    wisps: {
      atlas: { id: "atlas", name: "Atlas", role: "Research", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
      muted: { id: "muted", name: "Muted", role: "Quiet", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
    },
    chats: {
      atlas: wispChat("atlas"),
      muted: wispChat("muted", { notifyOnUpdatesEnabled: false }),
      circle: {
        id: "circle",
        kind: "circle",
        name: "Team",
        label: "",
        description: "",
        memberIds: ["atlas"],
        notifyOnUpdatesEnabled: true,
        preview: "",
        messages: [],
      },
    },
    statuses: {},
    liveMessages: {},
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
    ...overrides,
  };
}

function connected(epoch = 1): ConnectionsView {
  return {
    activeId: "local",
    profiles: [],
    status: { profileId: "local", phase: "local", epoch },
    secureStorageAvailable: true,
  } as unknown as ConnectionsView;
}

function approval(approvalId: string, conversationId = "atlas"): ToolApprovalRequest {
  return {
    approvalId,
    conversationId,
    toolCallId: `call-${approvalId}`,
    toolName: "write",
    category: "modify_file",
    scope: { kind: "workspace_path", display: "notes.md" },
    summary: "Modify notes.md",
    expiresAt: "2026-10-15T13:00:00.000Z",
  } as ToolApprovalRequest;
}

async function setup(initial = state()) {
  const host = {
    show: vi.fn(),
    setBadge: vi.fn(),
    requestAttention: vi.fn(),
    windowFocused: vi.fn(() => false),
    loadState: vi.fn(async () => initial),
  } satisfies SystemNotificationHost;
  const notifier = new SystemNotifier(host);
  notifier.handlePush(WISP_IPC_CHANNELS.connectionsChanged, connected());
  await notifier.idle();
  let sequence = 0;
  const send = async (event: ConversationAgentEvent) => {
    sequence += 1;
    notifier.handlePush(WISP_IPC_CHANNELS.agentEvent, { ...event, sequence });
    await notifier.idle();
    await Promise.resolve();
  };
  const reply = async (conversationId: string, text: string) => {
    await send({ type: "conversation_status", conversationId, status: "working" });
    await send({
      type: "assistant_message_started",
      conversationId,
      requestId: "r",
      messageId: "r:assistant",
      createdAt: "2026-10-15T12:00:00.000Z",
    });
    await send({ type: "assistant_text_delta", conversationId, requestId: "r", messageId: "r:assistant", delta: text });
    await send({ type: "conversation_status", conversationId, status: "idle" });
  };
  return { host, notifier, send, reply };
}

describe("SystemNotifier", () => {
  it("notifies a finished reply with the Wisp's name and the start of what it wrote", async () => {
    const { host, reply } = await setup();
    await reply("atlas", "## Found it\n\nThe **answer** is [here](https://example.com).");
    expect(host.show).toHaveBeenCalledWith({
      title: "Atlas",
      body: "Found it The answer is here.",
      target: { conversationId: "atlas" },
    });
  });

  it("keeps quiet about the conversation on screen while the window has focus", async () => {
    const { host, notifier, reply } = await setup();
    notifier.setFocus("atlas");
    host.windowFocused.mockReturnValue(true);
    await reply("atlas", "Done");
    expect(host.show).not.toHaveBeenCalled();
    host.windowFocused.mockReturnValue(false);
    await reply("atlas", "Done again");
    expect(host.show).toHaveBeenCalledTimes(1);
  });

  it("follows the settings and each Wisp's own notification choice, and skips circles", async () => {
    const { host, notifier, reply } = await setup();
    await reply("muted", "Hi");
    await reply("circle", "Hi");
    notifier.configure({ ...DEFAULT_SYSTEM_NOTIFICATION_SETTINGS, onCompletion: false });
    await reply("atlas", "Hi");
    notifier.configure({ ...DEFAULT_SYSTEM_NOTIFICATION_SETTINGS, enabled: false });
    await reply("atlas", "Hi");
    expect(host.show).not.toHaveBeenCalled();
  });

  it("says why a turn failed instead of that it finished", async () => {
    const { host, send } = await setup();
    await send({ type: "conversation_status", conversationId: "atlas", status: "working" });
    await send({
      type: "conversation_error",
      conversationId: "atlas",
      requestId: "r",
      error: { code: "model_unavailable", message: "The provider is out of credits.", retryable: false },
    });
    await send({ type: "conversation_status", conversationId: "atlas", status: "idle" });
    expect(host.show).toHaveBeenCalledTimes(1);
    expect(host.show).toHaveBeenCalledWith(expect.objectContaining({ body: "The provider is out of credits." }));
  });

  it("asks for attention for an approval and counts it on the badge until it is resolved", async () => {
    const { host, send } = await setup();
    expect(host.setBadge).toHaveBeenLastCalledWith(0);
    await send({ type: "tool_approval_requested", conversationId: "atlas", request: approval("a1") });
    expect(host.requestAttention).toHaveBeenCalled();
    expect(host.show).toHaveBeenCalledWith({
      title: "Atlas",
      body: "Needs approval: Modify notes.md",
      target: { conversationId: "atlas", approvalId: "a1" },
    });
    expect(host.setBadge).toHaveBeenLastCalledWith(1);
    await send({
      type: "tool_approval_resolved",
      conversationId: "atlas",
      approvalId: "a1",
      toolCallId: "call-a1",
      decision: "allow_once",
    });
    expect(host.setBadge).toHaveBeenLastCalledWith(0);
  });

  it("counts unread conversations and pending approvals on the badge", async () => {
    const { host, notifier } = await setup(state({ pendingToolApprovals: [approval("a1")] }));
    expect(host.setBadge).toHaveBeenLastCalledWith(1);
    notifier.handlePush(WISP_IPC_CHANNELS.conversationChanged, {
      chat: wispChat("atlas", { unread: true, unreadCount: 2 }),
      added: [],
      updated: [],
    });
    expect(host.setBadge).toHaveBeenLastCalledWith(2);
    notifier.handlePush(WISP_IPC_CHANNELS.conversationChanged, { chat: wispChat("atlas"), added: [], updated: [] });
    expect(host.setBadge).toHaveBeenLastCalledWith(1);
  });

  it("loads a Wisp it does not know yet before notifying about it", async () => {
    const { host, reply } = await setup();
    const later = state();
    host.loadState.mockResolvedValue({
      ...later,
      wisps: {
        ...later.wisps,
        nova: { id: "nova", name: "Nova", role: "New", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
      },
      chats: { ...later.chats, nova: wispChat("nova") },
    });
    await reply("nova", "Hello");
    expect(host.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Nova" }));
  });

  it("notifies a job's message with its text", async () => {
    const { host, notifier, send } = await setup();
    notifier.handlePush(WISP_IPC_CHANNELS.conversationChanged, {
      chat: wispChat("atlas"),
      added: [
        {
          id: "job-run-1",
          type: "incoming",
          text: "Two new posts",
          job: { jobId: "j", runId: "run-1", title: "Blog watch" },
        },
      ],
      updated: [],
    });
    await send({ type: "job_message_delivered", conversationId: "atlas", jobId: "j", messageId: "job-run-1" });
    expect(host.show).toHaveBeenCalledWith(expect.objectContaining({ body: "Two new posts" }));
  });

  it("loads again when the connection changes, and retries when the backend had nothing to give", async () => {
    const { host, notifier } = await setup();
    expect(host.loadState).toHaveBeenCalledTimes(1);
    notifier.handlePush(WISP_IPC_CHANNELS.connectionsChanged, connected(1));
    expect(host.loadState).toHaveBeenCalledTimes(1);
    host.loadState.mockResolvedValueOnce(undefined);
    notifier.handlePush(WISP_IPC_CHANNELS.connectionsChanged, connected(2));
    await notifier.idle();
    notifier.handlePush(WISP_IPC_CHANNELS.connectionsChanged, connected(2));
    await notifier.idle();
    expect(host.loadState).toHaveBeenCalledTimes(3);
  });
});

describe("notificationBody", () => {
  it("drops code and cuts a long reply short", () => {
    expect(notificationBody("Run this:\n```sh\nnpm test\n```\n- then `deploy`")).toBe("Run this: then deploy");
    const body = notificationBody("word ".repeat(100));
    expect(body.length).toBeLessThanOrEqual(120);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("system notification IPC handlers", () => {
  it("rejects untrusted senders and malformed settings, and hands a waiting target over once", async () => {
    const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
    const notifier = { configure: vi.fn(), setFocus: vi.fn(), test: vi.fn() };
    let target: { conversationId: string } | null = { conversationId: "atlas" };
    let trusted = false;
    registerSystemNotificationHandlers(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (event: unknown, payload?: unknown) => Promise<unknown>);
        },
        removeHandler: vi.fn(),
      },
      {
        notifier,
        takeTarget: () => {
          const taken = target;
          target = null;
          return taken;
        },
      },
      () => trusted,
    );
    const invoke = (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload);

    expect(
      await invoke(WISP_IPC_CHANNELS.configureSystemNotifications, DEFAULT_SYSTEM_NOTIFICATION_SETTINGS),
    ).toMatchObject({ ok: false });
    trusted = true;
    expect(
      await invoke(WISP_IPC_CHANNELS.configureSystemNotifications, {
        ...DEFAULT_SYSTEM_NOTIFICATION_SETTINGS,
        enabled: "yes",
      }),
    ).toMatchObject({ ok: false });
    expect(await invoke(WISP_IPC_CHANNELS.setNotificationFocus, { conversationId: 4 })).toMatchObject({ ok: false });
    expect(await invoke(WISP_IPC_CHANNELS.testSystemNotification, { kind: "loud" })).toMatchObject({ ok: false });
    expect(notifier.configure).not.toHaveBeenCalled();
    expect(notifier.setFocus).not.toHaveBeenCalled();
    expect(notifier.test).not.toHaveBeenCalled();

    expect(await invoke(WISP_IPC_CHANNELS.configureSystemNotifications, DEFAULT_SYSTEM_NOTIFICATION_SETTINGS)).toEqual({
      ok: true,
      value: {},
    });
    expect(notifier.configure).toHaveBeenCalledWith(DEFAULT_SYSTEM_NOTIFICATION_SETTINGS);
    await invoke(WISP_IPC_CHANNELS.setNotificationFocus, { conversationId: null });
    expect(notifier.setFocus).toHaveBeenCalledWith(null);
    await invoke(WISP_IPC_CHANNELS.testSystemNotification, { kind: "error" });
    expect(notifier.test).toHaveBeenCalledWith("error");
    expect(await invoke(WISP_IPC_CHANNELS.takeNotificationTarget)).toEqual({
      ok: true,
      value: { conversationId: "atlas" },
    });
    expect(await invoke(WISP_IPC_CHANNELS.takeNotificationTarget)).toEqual({ ok: true, value: null });
  });
});
