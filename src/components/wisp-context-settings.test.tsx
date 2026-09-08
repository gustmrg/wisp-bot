import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { type ContextCommand, DEFAULT_CONTEXT_POLICY } from "../../shared/context-policy";
import type { ConversationAgentEvent } from "../../shared/contracts";
import { WispContextSettings } from "./wisp-context-settings";

it("loads lazily, saves memory and requires an explicit new-topic choice", async () => {
  const user = userEvent.setup();
  const view = {
    policy: DEFAULT_CONTEXT_POLICY,
    memory: "",
    summary: "SQLite selected. Migration pending.",
    lastRenewedAt: null,
    lastActivityAt: null,
    tokens: 14000,
  };
  const manageContext = vi.fn(async ({ command }: { command: ContextCommand }) => ({
    ok: true,
    value: command.action === "save" ? { ...view, policy: command.policy, memory: command.memory } : view,
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      manageContext,
      getConversationModel: vi.fn(async () => ({ ok: true, value: { status: "idle" } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  render(<WispContextSettings conversationId="one" />);
  expect(manageContext).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Context & memory" }));
  const memory = await screen.findByRole("textbox", { name: "Saved memory" });
  await user.type(memory, "Use Portuguese");
  await user.click(screen.getByRole("button", { name: "Save context settings" }));
  expect(manageContext).toHaveBeenLastCalledWith({
    conversationId: "one",
    command: { action: "save", policy: DEFAULT_CONTEXT_POLICY, memory: "Use Portuguese" },
  });
  await user.click(screen.getByRole("button", { name: "Start new topic" }));
  expect(manageContext).not.toHaveBeenCalledWith(expect.objectContaining({ command: { action: "new_topic" } }));
  await user.click(screen.getByRole("button", { name: "Start fresh context" }));
  expect(manageContext).toHaveBeenLastCalledWith({ conversationId: "one", command: { action: "new_topic" } });
});

it("disables context mutations while a Wisp is working", async () => {
  const user = userEvent.setup();
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      manageContext: vi.fn(async () => ({
        ok: true,
        value: {
          policy: DEFAULT_CONTEXT_POLICY,
          memory: "",
          summary: null,
          lastRenewedAt: null,
          lastActivityAt: null,
          tokens: 14000,
        },
      })),
      getConversationModel: vi.fn(async () => ({ ok: true, value: { status: "working" } })),
      subscribeToAgentEvents: vi.fn(() => () => undefined),
    },
  });
  render(<WispContextSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Context & memory" }));
  expect(await screen.findByRole("button", { name: "Summarize context" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start new topic" })).toBeDisabled();
});

it("keeps a memory draft tied to its loaded revision after remote context renewal", async () => {
  const user = userEvent.setup();
  let view = {
    revision: 3,
    policy: DEFAULT_CONTEXT_POLICY,
    memory: "Original",
    summary: null,
    lastRenewedAt: null,
    lastActivityAt: null,
    tokens: 14000,
  };
  let onEvent: ((event: ConversationAgentEvent) => void) | undefined;
  const manageContext = vi.fn(async ({ command }: { command: ContextCommand }) =>
    command.action === "get"
      ? { ok: true, value: view }
      : { ok: false, error: { code: "conflict", message: "Context changed on another device. Reload." } },
  );
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      manageContext,
      getConversationModel: vi.fn(async () => ({ ok: true, value: { status: "idle" } })),
      subscribeToAgentEvents: (listener: (event: ConversationAgentEvent) => void) => {
        onEvent = listener;
        return () => undefined;
      },
    },
  });
  render(<WispContextSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Context & memory" }));
  const memory = await screen.findByRole("textbox", { name: "Saved memory" });
  await user.clear(memory);
  await user.type(memory, "My unsaved draft");
  view = { ...view, revision: 4, memory: "Saved on other device" };
  await act(async () =>
    onEvent?.({
      type: "conversation_context_renewed",
      conversationId: "one",
      kind: "new_topic",
      createdAt: new Date().toISOString(),
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save context settings" }));
  expect(manageContext).toHaveBeenLastCalledWith({
    conversationId: "one",
    expectedRevision: 3,
    command: { action: "save", policy: DEFAULT_CONTEXT_POLICY, memory: "My unsaved draft" },
  });
  expect(memory).toHaveValue("My unsaved draft");
  await user.click(await screen.findByRole("button", { name: "Reload server settings" }));
  expect(await screen.findByDisplayValue("Saved on other device")).toBeVisible();
});
