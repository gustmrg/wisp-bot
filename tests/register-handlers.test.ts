import { describe, expect, it, vi } from "vitest";

import { AgentIpcController, registerAgentHandlers } from "../electron/ipc/register-handlers.js";
import { AgentRegistry } from "../backend/agent-registry.js";
import { FakeConversationAgentFactory } from "../backend/fake-conversation-agent.js";
import { WISP_IPC_CHANNELS, type ConversationAgentEvent } from "../shared/contracts.js";

describe("AgentIpcController", () => {
  it("starts a conversation and publishes fake events", async () => {
    const publish = vi.fn<(event: ConversationAgentEvent) => void>();
    const registry = new AgentRegistry(new FakeConversationAgentFactory(), publish);
    await registry.create(context("wisp-1"));
    await registry.applyModel({ providerId: "test", modelId: "test" });
    const controller = new AgentIpcController(registry);

    expect(await controller.start({ conversationId: "wisp-1" })).toEqual({ ok: true, value: {} });
    expect(
      await controller.send({
        conversationId: "wisp-1",
        requestId: "request-1",
        text: "Hello",
      }),
    ).toEqual({ ok: true, value: {} });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant_message_completed",
        conversationId: "wisp-1",
        requestId: "request-1",
      }),
    );
    await registry.disposeAll();
  });

  it("returns sanitized errors for invalid and missing conversations", async () => {
    const controller = new AgentIpcController(new AgentRegistry(new FakeConversationAgentFactory(), () => undefined));

    expect(await controller.start({ conversationId: "../invalid" })).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "The backend request is invalid.",
        retryable: false,
      },
    });
    expect(
      await controller.send({
        conversationId: "missing",
        requestId: "request-1",
        text: "Hello",
      }),
    ).toEqual({
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
      new AgentRegistry(new FakeConversationAgentFactory(), () => undefined),
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
    registration.dispose();
  });
});

function context(conversationId: string) {
  return {
    conversationId,
    sessionId: `${conversationId}-session`,
    workspaceDirectory: `/tmp/${conversationId}/workspace`,
    sessionDirectory: `/tmp/${conversationId}/session`,
    configDirectory: `/tmp/${conversationId}/config`,
  };
}

it("scopes model changes to the requested conversation and supports clearing its override", async () => {
  const registry = new AgentRegistry(new FakeConversationAgentFactory(), () => undefined);
  await registry.restore([context("one"), context("two")], { providerId: "global", modelId: "global" });
  const save = vi.fn(async (id, model) => registry.applyConversationModel(id, model));
  const controller = new AgentIpcController(registry, save);
  const model = { providerId: "custom", modelId: "custom" };
  expect(await controller.applyModel({ conversationId: "one", model })).toMatchObject({ ok: true });
  expect(save).toHaveBeenCalledWith("one", model);
  expect(registry.getModelView("two").override).toBeNull();
  expect(await controller.getModel({ conversationId: "one" })).toMatchObject({ ok: true, value: { override: model } });
  expect(await controller.applyModel({ conversationId: "one", model: null })).toMatchObject({ ok: true });
  expect(registry.getModelView("one").effective?.modelId).toBe("global");
  expect(await controller.applyModel({ conversationId: "../invalid", model })).toMatchObject({ ok: false });
  expect(await controller.applyModel({ conversationId: "one", model: { providerId: "custom" } })).toMatchObject({
    ok: false,
  });
  await registry.disposeAll();
});
