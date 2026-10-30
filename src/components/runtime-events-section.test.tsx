import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WispApi } from "../../shared/contracts";
import type { RuntimeEventEntry, RuntimeEventLogView } from "../../shared/runtime-events";
import { RuntimeEventsSection } from "@/components/runtime-events-section";

const event = (sequence: number, type: string): RuntimeEventEntry => ({
  sequence,
  runtime: "pi",
  type,
  receivedAt: "2026-10-30T12:00:00.000Z",
  payload: { type, sequence },
});

const view = (recording: boolean, events: RuntimeEventEntry[] = []): RuntimeEventLogView => ({
  conversationId: "wisp-1",
  recording,
  events,
  dropped: false,
});

function exposeApi(
  api: Pick<WispApi, "getRuntimeEvents" | "setRuntimeEventRecording"> &
    Partial<Pick<WispApi, "clearRuntimeEvents" | "saveRuntimeEventsToWorkspace">>,
) {
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
}

afterEach(() => {
  Reflect.deleteProperty(window, "wisp");
  vi.useRealTimers();
});

describe("RuntimeEventsSection", () => {
  it("starts off and shows nothing of the runtime until recording is turned on", async () => {
    const getRuntimeEvents = vi.fn(async () => ({ ok: true as const, value: view(false) }));
    const setRuntimeEventRecording = vi.fn(async () => ({ ok: true as const, value: view(true) }));
    exposeApi({ getRuntimeEvents, setRuntimeEventRecording });
    const user = userEvent.setup();
    render(<RuntimeEventsSection conversationId="wisp-1" />);

    const toggle = await screen.findByRole("switch", { name: "Record runtime events" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("list", { name: "Runtime events" })).not.toBeInTheDocument();
    expect(getRuntimeEvents).toHaveBeenCalledWith({ conversationId: "wisp-1" });

    await user.click(toggle);
    expect(setRuntimeEventRecording).toHaveBeenCalledWith({ conversationId: "wisp-1", recording: true });
    expect(await screen.findByText("Send a message to see the events of the reply here.")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("adds new events while recording, shows each payload, and copies them all", async () => {
    const reads: RuntimeEventLogView[] = [
      view(true, [event(1, "agent_start")]),
      view(true, [event(2, "message_update")]),
    ];
    const getRuntimeEvents = vi.fn(async () => ({ ok: true as const, value: reads.shift() ?? view(true) }));
    const setRuntimeEventRecording = vi.fn(async () => ({
      ok: true as const,
      value: view(false, [event(1, "agent_start"), event(2, "message_update")]),
    }));
    exposeApi({ getRuntimeEvents, setRuntimeEventRecording });
    const user = userEvent.setup();
    render(<RuntimeEventsSection conversationId="wisp-1" />);

    const list = await screen.findByRole("list", { name: "Runtime events" });
    expect(within(list).getByText("agent_start")).toBeVisible();
    // The next read, a second later, asks only for what came after the last event.
    expect(await within(list).findByText("message_update", {}, { timeout: 3_000 })).toBeVisible();
    expect(getRuntimeEvents).toHaveBeenCalledWith({ conversationId: "wisp-1", after: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("2 events");

    await user.click(within(list).getByText("agent_start"));
    expect(within(list).getByText(/"sequence": 1/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy events" }));
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual([
      event(1, "agent_start"),
      event(2, "message_update"),
    ]);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();

    // Turning recording off keeps what was recorded.
    await user.click(screen.getByRole("switch", { name: "Record runtime events" }));
    expect(setRuntimeEventRecording).toHaveBeenCalledWith({ conversationId: "wisp-1", recording: false });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Record runtime events" })).toHaveAttribute("aria-checked", "false"),
    );
    expect(screen.getByRole("list", { name: "Runtime events" })).toBeVisible();
  });

  it("saves the events to the workspace and clears them", async () => {
    const getRuntimeEvents = vi.fn(async () => ({ ok: true as const, value: view(false, [event(1, "agent_start")]) }));
    const saveRuntimeEventsToWorkspace = vi.fn(async () => ({
      ok: true as const,
      value: { path: "inbox/runtime-events.jsonl", size: 120 },
    }));
    const clearRuntimeEvents = vi.fn(async () => ({ ok: true as const, value: view(false) }));
    exposeApi({
      getRuntimeEvents,
      setRuntimeEventRecording: vi.fn(),
      saveRuntimeEventsToWorkspace,
      clearRuntimeEvents,
    });
    const user = userEvent.setup();
    render(<RuntimeEventsSection conversationId="wisp-1" />);

    await user.click(await screen.findByRole("button", { name: "Save to workspace" }));
    expect(saveRuntimeEventsToWorkspace).toHaveBeenCalledWith({ conversationId: "wisp-1" });
    expect(await screen.findByText("inbox/runtime-events.jsonl")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(clearRuntimeEvents).toHaveBeenCalledWith({ conversationId: "wisp-1" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Runtime events" })).not.toBeInTheDocument());
    expect(screen.queryByText("inbox/runtime-events.jsonl")).not.toBeInTheDocument();
  });

  it("does not ask for events while its tab is hidden", () => {
    const getRuntimeEvents = vi.fn(async () => ({ ok: true as const, value: view(true) }));
    exposeApi({ getRuntimeEvents, setRuntimeEventRecording: vi.fn() });
    render(<RuntimeEventsSection conversationId="wisp-1" active={false} />);
    expect(getRuntimeEvents).not.toHaveBeenCalled();
  });
});
