import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionEventMessage } from "../../shared/connections";
import type { WispApi } from "../../shared/contracts";
import { createEnvironmentApi, useWispApi, WispApiProvider } from "./environment-api";

function createMockBaseApi() {
  const listeners = new Set<(event: ConnectionEventMessage) => void>();
  const invokeConnectionOperation = vi.fn(async () => ({ ok: true as const, value: { routed: true } }));
  const getAiSettings = vi.fn(async () => ({ ok: true as const, value: { direct: true } }));
  const getConnections = vi.fn(async () => ({ ok: true as const, value: { activeId: "local" } }));
  const subscribeToConnectionEvents = vi.fn((listener: (event: ConnectionEventMessage) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  const api = {
    getAiSettings,
    saveAiSettings: vi.fn(),
    getConnections,
    invokeConnectionOperation,
    subscribeToConnectionEvents,
    subscribeToAgentEvents: vi.fn(() => () => undefined),
    subscribeToConversationChanges: vi.fn(() => () => undefined),
    subscribeToWisps: vi.fn(() => () => undefined),
    subscribeToMcpSettings: vi.fn(() => () => undefined),
    subscribeToPluginSettings: vi.fn(() => () => undefined),
    subscribeToScheduledMessages: vi.fn(() => () => undefined),
    subscribeToMessageQueue: vi.fn(() => () => undefined),
    subscribeToJobs: vi.fn(() => () => undefined),
  } as unknown as WispApi;

  return {
    api,
    invokeConnectionOperation,
    getAiSettings,
    getConnections,
    subscribeToConnectionEvents,
    emitConnectionEvent: (event: ConnectionEventMessage) => {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe("createEnvironmentApi", () => {
  it("returns baseApi directly when targeting the active environment or no environment", () => {
    const { api } = createMockBaseApi();

    expect(createEnvironmentApi(undefined, "local", api)).toBe(api);
    expect(createEnvironmentApi("local", "local", api)).toBe(api);
    expect(createEnvironmentApi("remote-1", "remote-1", api)).toBe(api);
  });

  it("routes runtime operations via invokeConnectionOperation and preserves desktop-only methods", async () => {
    const { api, invokeConnectionOperation, getAiSettings, getConnections } = createMockBaseApi();
    const scoped = createEnvironmentApi("remote-1", "local", api);

    expect(scoped).not.toBe(api);
    expect(Object.isFrozen(scoped)).toBe(true);

    const aiResult = await scoped.getAiSettings();
    expect(aiResult).toEqual({ ok: true, value: { routed: true } });
    expect(getAiSettings).not.toHaveBeenCalled();
    expect(invokeConnectionOperation).toHaveBeenCalledWith({
      connectionId: "remote-1",
      operation: "getAiSettings",
    });

    await scoped.saveAiSettings({ selection: { providerId: "openrouter", modelId: "m" } });
    expect(invokeConnectionOperation).toHaveBeenCalledWith({
      connectionId: "remote-1",
      operation: "saveAiSettings",
      payload: { selection: { providerId: "openrouter", modelId: "m" } },
    });

    // Non-runtime methods delegate directly to baseApi.
    await scoped.getConnections();
    expect(getConnections).toHaveBeenCalledTimes(1);
  });

  it("filters runtime event subscriptions by connectionId and event type and cleans up on unsubscribe", () => {
    const { api, emitConnectionEvent, listenerCount } = createMockBaseApi();
    const scoped = createEnvironmentApi("remote-1", "local", api);

    const agentPayloads: unknown[] = [];
    const mcpPayloads: unknown[] = [];
    const unsubAgent = scoped.subscribeToAgentEvents((payload) => agentPayloads.push(payload));
    const unsubMcp = scoped.subscribeToMcpSettings((payload) => mcpPayloads.push(payload));
    expect(listenerCount()).toBe(2);

    // Wrong connectionId -> ignored.
    emitConnectionEvent({ connectionId: "local", type: "agentEvent", payload: { id: "wrong-env" } });
    // Right connectionId, wrong type -> ignored by agent listener, delivered to mcp listener.
    emitConnectionEvent({ connectionId: "remote-1", type: "mcpSettingsChanged", payload: { servers: [] } });
    // Right connectionId and type -> delivered to agent listener.
    emitConnectionEvent({ connectionId: "remote-1", type: "agentEvent", payload: { id: "right-env" } });

    expect(agentPayloads).toEqual([{ id: "right-env" }]);
    expect(mcpPayloads).toEqual([{ servers: [] }]);

    unsubAgent();
    unsubMcp();
    expect(listenerCount()).toBe(0);
  });
});

describe("WispApiProvider and useWispApi", () => {
  function Probe({ label }: { label: string }) {
    const api = useWispApi();
    return (
      <button type="button" onClick={() => void api.getAiSettings()}>
        {label}
      </button>
    );
  }

  it("falls back to window.wisp outside a provider and uses the scoped API inside WispApiProvider", () => {
    const { api: baseApi, getAiSettings, invokeConnectionOperation } = createMockBaseApi();
    Object.defineProperty(window, "wisp", { configurable: true, value: baseApi });

    render(
      <>
        <Probe label="outside" />
        <WispApiProvider connectionId="remote-2" activeConnectionId="local">
          <Probe label="inside-remote" />
        </WispApiProvider>
        <WispApiProvider connectionId="local" activeConnectionId="local">
          <Probe label="inside-active" />
        </WispApiProvider>
      </>,
    );

    screen.getByText("outside").click();
    expect(getAiSettings).toHaveBeenCalledTimes(1);
    expect(invokeConnectionOperation).not.toHaveBeenCalled();

    screen.getByText("inside-remote").click();
    expect(invokeConnectionOperation).toHaveBeenCalledWith({
      connectionId: "remote-2",
      operation: "getAiSettings",
    });

    screen.getByText("inside-active").click();
    expect(getAiSettings).toHaveBeenCalledTimes(2);
  });
});
