import { describe, expect, it, vi } from "vitest";

import { AgentIpcController, registerAgentHandlers } from "../electron/ipc/register-handlers.js";
import { FakeConversationAgentFactory } from "../electron/backend/fake-conversation-agent.js";
import { WISP_IPC_CHANNELS, type ConversationAgentEvent } from "../shared/contracts.js";

describe("AgentIpcController", () => {
  it("starts a conversation and publishes fake events", async () => {
    const publish = vi.fn<(event: ConversationAgentEvent) => void>();
    const controller = new AgentIpcController(new FakeConversationAgentFactory(), publish);

    expect(await controller.start({ conversationId: "wisp-1" })).toEqual({ ok: true, value: {} });
    expect(await controller.send({
      conversationId: "wisp-1",
      requestId: "request-1",
      text: "Hello",
    })).toEqual({ ok: true, value: {} });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "assistant_message_completed",
      conversationId: "wisp-1",
      requestId: "request-1",
    }));
    await controller.disposeAll();
  });

  it("returns sanitized errors for invalid and missing conversations", async () => {
    const controller = new AgentIpcController(new FakeConversationAgentFactory(), () => undefined);

    expect(await controller.start({ conversationId: "../invalid" })).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The backend request is invalid.",
        retryable: false,
      },
    });
    expect(await controller.send({
      conversationId: "missing",
      requestId: "request-1",
      text: "Hello",
    })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "The conversation is not running.",
        retryable: false,
      },
    });
  });

  it("rejects untrusted IPC senders before parsing payloads", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const registration = registerAgentHandlers(
      ipcMain as never,
      new FakeConversationAgentFactory(),
      () => undefined,
      () => false,
    );
    const handler = handlers.get(WISP_IPC_CHANNELS.startConversation);

    await expect(handler?.({}, { conversationId: "wisp-1" })).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The backend request is invalid.",
        retryable: false,
      },
    });
    await registration.dispose();
  });
});
