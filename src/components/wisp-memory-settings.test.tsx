import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { SequencedConversationAgentEvent } from "../../shared/contracts";
import type { MemoryEntryView, MemoryView } from "../../shared/memory";
import { WispMemorySettings } from "./wisp-memory-settings";

function entry(
  id: string,
  text: string,
  scope: "user" | "wisp",
  extra: Partial<MemoryEntryView> = {},
): MemoryEntryView {
  return {
    id,
    scope,
    wispId: scope === "wisp" ? "lumi" : null,
    text,
    source: "owner",
    status: "active",
    replaces: null,
    observedAt: "2026-10-23T12:00:00.000Z",
    expiresAt: null,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...extra,
  };
}

const view: MemoryView = {
  entries: [
    entry("m1", "Prefers short answers.", "user"),
    entry("m2", "Works on Wisp Bot.", "wisp", { source: "agent" }),
    entry("m3", "Old fact.", "wisp", { status: "removed" }),
  ],
  usage: [
    { scope: "user", used: 22, limit: 1500 },
    { scope: "wisp", used: 18, limit: 4000 },
  ],
};

function mockWisp(overrides: Record<string, unknown> = {}) {
  let listener: ((event: SequencedConversationAgentEvent) => void) | undefined;
  const api = {
    getMemory: vi.fn(async () => ({ ok: true as const, value: view })),
    applyMemory: vi.fn(async () => ({ ok: true as const, value: view })),
    exportMemory: vi.fn(async () => ({
      ok: true as const,
      value: { fileName: "MEMORY.md", markdown: "# MEMORY.md\n\n- Works on Wisp Bot.\n" },
    })),
    subscribeToAgentEvents: (next: typeof listener) => {
      listener = next;
      return () => undefined;
    },
    ...overrides,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return { api, emit: (event: SequencedConversationAgentEvent) => listener?.(event) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("lists both scopes with their use, origin and history", async () => {
  mockWisp();
  render(<WispMemorySettings conversationId="one" />);

  const about = await screen.findByRole("region", { name: "About you · every Wisp" });
  expect(within(about).getByText("Prefers short answers.")).toBeInTheDocument();
  expect(within(about).getByText("22 / 1,500 characters")).toBeInTheDocument();
  expect(within(about).getByText(/^You · /)).toBeInTheDocument();

  const wisp = screen.getByRole("region", { name: "This Wisp" });
  expect(within(wisp).getByText("Works on Wisp Bot.")).toBeInTheDocument();
  expect(within(wisp).getByText(/^Wisp · /)).toBeInTheDocument();
  expect(within(wisp).getByText("Removed and replaced (1)")).toBeInTheDocument();
});

it("adds, edits, removes and restores entries", async () => {
  const user = userEvent.setup();
  const { api } = mockWisp();
  render(<WispMemorySettings conversationId="one" />);
  const wisp = await screen.findByRole("region", { name: "This Wisp" });

  await user.type(within(wisp).getByRole("textbox", { name: "New entry for This Wisp" }), "Ships on Fridays.");
  await user.click(within(wisp).getByRole("button", { name: "Add" }));
  expect(api.applyMemory).toHaveBeenLastCalledWith({
    conversationId: "one",
    operations: [{ op: "add", scope: "wisp", text: "Ships on Fridays." }],
  });
  expect(within(wisp).getByRole("textbox", { name: "New entry for This Wisp" })).toHaveValue("");

  await user.click(within(wisp).getByRole("button", { name: "Edit Works on Wisp Bot." }));
  const text = within(wisp).getByRole("textbox", { name: "Entry text" });
  await user.clear(text);
  await user.type(text, "Works on Wisp Bot and Aura.");
  await user.click(within(wisp).getByRole("button", { name: "Save" }));
  expect(api.applyMemory).toHaveBeenLastCalledWith({
    conversationId: "one",
    operations: [{ op: "patch", id: "m2", text: "Works on Wisp Bot and Aura." }],
  });

  await user.click(within(wisp).getByRole("button", { name: "Remove Works on Wisp Bot." }));
  expect(api.applyMemory).toHaveBeenLastCalledWith({ conversationId: "one", operations: [{ op: "remove", id: "m2" }] });

  await user.click(within(wisp).getByText("Removed and replaced (1)"));
  await user.click(within(wisp).getByRole("button", { name: "Restore" }));
  expect(api.applyMemory).toHaveBeenLastCalledWith({
    conversationId: "one",
    operations: [{ op: "restore", id: "m3" }],
  });
});

it("edits a scope as text after showing what changes", async () => {
  const user = userEvent.setup();
  const { api } = mockWisp();
  render(<WispMemorySettings conversationId="one" />);
  const about = await screen.findByRole("region", { name: "About you · every Wisp" });

  await user.click(within(about).getByRole("button", { name: "Edit as text" }));
  const text = within(about).getByRole("textbox", { name: "About you · every Wisp as text" });
  expect(text).toHaveValue("Prefers short answers.");
  await user.type(text, "{Enter}Lives in Recife.");
  await user.click(within(about).getByRole("button", { name: "Review changes" }));
  expect(within(about).getByRole("status")).toHaveTextContent("1 added");
  expect(api.applyMemory).not.toHaveBeenCalled();

  await user.click(within(about).getByRole("button", { name: "Save changes" }));
  expect(api.applyMemory).toHaveBeenCalledWith({
    conversationId: "one",
    operations: [{ op: "add", scope: "user", text: "Lives in Recife." }],
  });
  expect(within(about).queryByRole("textbox", { name: "About you · every Wisp as text" })).not.toBeInTheDocument();
});

it("shows why a change was refused", async () => {
  const user = userEvent.setup();
  mockWisp({
    applyMemory: vi.fn(async () => ({
      ok: false as const,
      error: { code: "invalid_request", message: "Memory already has this as m1." },
    })),
  });
  render(<WispMemorySettings conversationId="one" />);
  const about = await screen.findByRole("region", { name: "About you · every Wisp" });
  await user.type(within(about).getByRole("textbox", { name: "New entry for About you · every Wisp" }), "x");
  await user.click(within(about).getByRole("button", { name: "Add" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Memory already has this as m1.");
  expect(within(about).getByRole("textbox", { name: "New entry for About you · every Wisp" })).toHaveValue("x");
});

it("exports a scope as a Markdown file", async () => {
  const user = userEvent.setup();
  const createObjectURL = vi.fn(() => "blob:memory");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const { api } = mockWisp();
  render(<WispMemorySettings conversationId="one" />);
  const wisp = await screen.findByRole("region", { name: "This Wisp" });

  await user.click(within(wisp).getByRole("button", { name: "Export MEMORY.md" }));
  expect(api.exportMemory).toHaveBeenCalledWith({ conversationId: "one", scope: "wisp" });
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalled();
});

it("reloads when the Wisp saves a memory", async () => {
  const { api, emit } = mockWisp();
  render(<WispMemorySettings conversationId="one" />);
  await screen.findByRole("region", { name: "This Wisp" });
  expect(api.getMemory).toHaveBeenCalledTimes(1);
  await act(async () => {
    emit({
      type: "turn_item",
      conversationId: "one",
      requestId: "request",
      groupId: "request:work",
      item: {
        id: "tool",
        toolName: "save_memory",
        status: "completed",
        startedAt: "2026-10-22T10:00:00.000Z",
        type: "tool",
      },
      sequence: 1,
    });
  });
  expect(api.getMemory).toHaveBeenCalledTimes(2);
});
