import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WispContextSettings } from "./wisp-context-settings";
import { DEFAULT_CONTEXT_POLICY, type ContextCommand } from "../../shared/context-policy";

it("loads, saves the policy with the old memory untouched, and requires an explicit new-topic choice", async () => {
  const user = userEvent.setup();
  const view = {
    policy: DEFAULT_CONTEXT_POLICY,
    memory: "Legacy saved memory",
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
  const idle = await screen.findByRole("spinbutton", { name: "Inactivity (hours)" });
  // Saved memory is edited under Memory now (ADR 029).
  expect(screen.queryByRole("textbox", { name: "Saved memory" })).not.toBeInTheDocument();
  await user.clear(idle);
  await user.type(idle, "48");
  await user.click(screen.getByRole("button", { name: "Save context settings" }));
  expect(manageContext).toHaveBeenLastCalledWith({
    conversationId: "one",
    command: { action: "save", policy: { ...DEFAULT_CONTEXT_POLICY, idleHours: 48 }, memory: "Legacy saved memory" },
  });
  await user.click(screen.getByRole("button", { name: "Start new topic" }));
  expect(manageContext).not.toHaveBeenCalledWith(expect.objectContaining({ command: { action: "new_topic" } }));
  await user.click(screen.getByRole("button", { name: "Start fresh context" }));
  expect(manageContext).toHaveBeenLastCalledWith({ conversationId: "one", command: { action: "new_topic" } });
});

it("disables context mutations while a Wisp is working", async () => {
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
  expect(await screen.findByRole("button", { name: "Summarize context" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start new topic" })).toBeDisabled();
});
