import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";

import type { ConnectionPushedEventType } from "../../shared/connections";
import type { WispApi } from "../../shared/contracts";
import { RUNTIME_OPERATIONS } from "../../shared/runtime-operations";

const RUNTIME_SUBSCRIPTIONS: ReadonlyArray<readonly [keyof WispApi, ConnectionPushedEventType]> = [
  ["subscribeToAgentEvents", "agentEvent"],
  ["subscribeToConversationChanges", "conversationChanged"],
  ["subscribeToWisps", "wispsChanged"],
  ["subscribeToMcpSettings", "mcpSettingsChanged"],
  ["subscribeToPluginSettings", "pluginSettingsChanged"],
  ["subscribeToScheduledMessages", "scheduledMessagesChanged"],
  ["subscribeToMessageQueue", "messageQueueChanged"],
  ["subscribeToJobs", "jobsChanged"],
];

/**
 * Returns a `WispApi` scoped to a specific environment.
 *
 * When `connectionId` is omitted or matches `activeConnectionId`, returns
 * `baseApi` directly so callers targeting the active environment incur zero
 * indirection. Otherwise, every allowlisted runtime operation is routed via
 * `invokeConnectionOperation` and every runtime subscription filters
 * `subscribeToConnectionEvents` by `connectionId`.
 */
export function createEnvironmentApi(
  connectionId: string | undefined,
  activeConnectionId: string | undefined,
  baseApi: WispApi = window.wisp,
): WispApi {
  if (!connectionId || connectionId === activeConnectionId) {
    return baseApi;
  }

  const scoped: Record<string, unknown> = { ...baseApi };

  for (const operation of RUNTIME_OPERATIONS) {
    scoped[operation] = (payload?: unknown) =>
      baseApi.invokeConnectionOperation({
        connectionId,
        operation,
        ...(payload !== undefined ? { payload } : {}),
      });
  }

  for (const [method, eventType] of RUNTIME_SUBSCRIPTIONS) {
    scoped[method] = (listener: (payload: unknown) => void) =>
      baseApi.subscribeToConnectionEvents((event) => {
        if (event.connectionId === connectionId && event.type === eventType) {
          listener(event.payload);
        }
      });
  }

  return Object.freeze(scoped) as unknown as WispApi;
}

const WispApiContext = createContext<WispApi | null>(null);

export interface WispApiProviderProps {
  /** Direct `WispApi` instance to provide; overrides `connectionId` resolution when supplied. */
  api?: WispApi;
  /** Target environment ID; when omitted or equal to `activeConnectionId`, uses the base bridge. */
  connectionId?: string;
  /** Currently active workspace environment ID. */
  activeConnectionId?: string;
  /** Underlying bridge to wrap; defaults to `window.wisp`. */
  baseApi?: WispApi;
  children?: ReactNode;
}

/**
 * Provides a `WispApi` scoped to a given environment to descendant components
 * (such as environment-scoped Settings panels and Team views).
 */
export function WispApiProvider({ api, connectionId, activeConnectionId, baseApi, children }: WispApiProviderProps) {
  const resolvedBase = baseApi ?? window.wisp;
  const value = useMemo(
    () => api ?? createEnvironmentApi(connectionId, activeConnectionId, resolvedBase),
    [api, connectionId, activeConnectionId, resolvedBase],
  );
  return createElement(WispApiContext.Provider, { value }, children);
}

/** Returns the nearest scoped `WispApi`, falling back to `window.wisp` outside a provider. */
export function useWispApi(): WispApi {
  return useContext(WispApiContext) ?? window.wisp;
}
