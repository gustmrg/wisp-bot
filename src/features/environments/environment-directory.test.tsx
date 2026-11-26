import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { testWisp } from "@/test/chat-fixtures";
import type { ConnectionEventMessage, ConnectionPhase, ConnectionsView } from "../../../shared/connections";
import type { ConversationStateView, WispsView } from "../../../shared/conversations";
import { EnvironmentDirectoryProvider, useEnvironmentDirectory } from "./environment-directory";

function state(id: string, name: string): ConversationStateView {
  return {
    initialized: true,
    wisps: { [id]: testWisp(id, { name }) },
    chats: { [id]: { id, kind: "wisp", wispId: id, notifyOnUpdatesEnabled: true, preview: "", messages: [] } },
    statuses: { [id]: "idle" },
    liveMessages: {},
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  };
}

function view(homePhase: ConnectionPhase): ConnectionsView {
  const summary = { workingWisps: 0, pendingApprovals: 0, unreadConversations: 0, wispCount: 1, circleCount: 0 };
  return {
    activeId: "local",
    profiles: [
      { id: "local", kind: "local", name: "This computer", paired: true },
      { id: "home", kind: "url", name: "Home server", url: "https://test-host.invalid", paired: true },
    ],
    status: { profileId: "local", phase: "local", epoch: 1 },
    secureStorageAvailable: true,
    environments: {
      local: { profileId: "local", phase: "local", ...summary },
      home: { profileId: "home", phase: homePhase, ...summary },
    },
  };
}

function Probe() {
  const { environments } = useEnvironmentDirectory();
  return (
    <ul>
      {environments.map((entry) => (
        <li key={entry.profile.id}>
          {`${entry.profile.name} (${entry.phase}): ${Object.values(entry.chats)
            .map((chat) => (chat.kind === "wisp" ? chat.wisp.name : chat.name))
            .join(", ")}`}
        </li>
      ))}
    </ul>
  );
}

const listeners = new Set<(event: ConnectionEventMessage) => void>();
const invokeConnectionOperation = vi.fn();

beforeEach(() => {
  listeners.clear();
  invokeConnectionOperation.mockReset().mockImplementation(async ({ connectionId }: { connectionId: string }) => ({
    ok: true,
    value: connectionId === "home" ? state("nova", "Nova") : state("atlas", "Atlas"),
  }));
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      invokeConnectionOperation,
      subscribeToConnectionEvents: vi.fn((listener: (event: ConnectionEventMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  });
});

function renderDirectory(initial: ConnectionsView) {
  const ui = (current: ConnectionsView) => (
    <ActiveConnectionContext.Provider value={current}>
      <EnvironmentDirectoryProvider>
        <Probe />
      </EnvironmentDirectoryProvider>
    </ActiveConnectionContext.Provider>
  );
  const { rerender } = render(ui(initial));
  return { update: (next: ConnectionsView) => rerender(ui(next)) };
}

function homeLoads(): number {
  return invokeConnectionOperation.mock.calls.filter(([request]) => request.connectionId === "home").length;
}

describe("EnvironmentDirectoryProvider", () => {
  it("loads each connected environment once, keeps it live, and reloads it after a reconnect", async () => {
    const { update } = renderDirectory(view("connected"));
    expect(await screen.findByText("This computer (local): Atlas")).toBeVisible();
    expect(await screen.findByText("Home server (connected): Nova")).toBeVisible();
    expect(invokeConnectionOperation).toHaveBeenCalledWith({ connectionId: "home", operation: "getConversationState" });

    const renamed: WispsView = { ...state("nova", "Nova"), wisps: { nova: testWisp("nova", { name: "Nova 2" }) } };
    act(() => {
      for (const listener of listeners) listener({ connectionId: "home", type: "wispsChanged", payload: renamed });
    });
    expect(screen.getByText("Home server (connected): Nova 2")).toBeVisible();

    // Reconnecting keeps what it last saw; connected again, it loads afresh, since events may have been missed.
    update(view("reconnecting"));
    expect(screen.getByText("Home server (reconnecting): Nova 2")).toBeVisible();
    expect(homeLoads()).toBe(1);
    update(view("connected"));
    expect(await screen.findByText("Home server (connected): Nova")).toBeVisible();
    expect(homeLoads()).toBe(2);

    update(view("error"));
    await waitFor(() => expect(screen.queryByText(/Home server/)).not.toBeInTheDocument());
  });

  it("tracks nothing with a single environment", () => {
    const single: ConnectionsView = { ...view("connected"), profiles: view("connected").profiles.slice(0, 1) };
    renderDirectory(single);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(invokeConnectionOperation).not.toHaveBeenCalled();
  });
});
