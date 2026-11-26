import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ChatViewCollection } from "@/chat-data";
import { environmentPhase, isEnvironmentConnected } from "@/components/settings/settings-environment-selector";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { chatViews } from "@/lib/chat-schema";
import {
  createConversationRuntime,
  reconcileConversationRuntime,
  reduceConversationAgentEvent,
  type ConversationRuntimeState,
} from "@/lib/conversation-stream";
import { createEnvironmentApi } from "@/lib/environment-api";
import type { ConnectionPhase, ConnectionProfileView, ConnectionsView } from "../../../shared/connections";
import type { SequencedConversationAgentEvent } from "../../../shared/contracts";
import {
  chatSummary,
  type ChatSummaryCollection,
  type ConversationDelta,
  type ManagedConversationStatus,
  type WispCollection,
  type WispsView,
} from "../../../shared/conversations";
import type { ToolApprovalRequest } from "../../../shared/tool-policy";

/** One environment's conversations as the directory last saw them. */
export interface DirectoryEnvironment {
  profile: ConnectionProfileView;
  phase: ConnectionPhase;
  loading: boolean;
  error: string | null;
  chats: ChatViewCollection;
  wisps: WispCollection;
  statuses: Record<string, ManagedConversationStatus>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  activity: Record<string, string | undefined>;
}

interface RawEnvironment {
  loading: boolean;
  error: string | null;
  chats: ChatSummaryCollection;
  wisps: WispCollection;
  runtime: ConversationRuntimeState;
}

interface EnvironmentDirectoryValue {
  /** False with a single environment and in the browser app, where nothing is tracked. */
  enabled: boolean;
  /** Connected and reconnecting environments, in the order of the connection profiles. */
  environments: ReadonlyArray<DirectoryEnvironment>;
}

const DISABLED: EnvironmentDirectoryValue = { enabled: false, environments: [] };

const EnvironmentDirectoryContext = createContext<EnvironmentDirectoryValue>(DISABLED);

/** Whether a client shows more than one environment at a time. */
export function isMultiEnvironment(view: ConnectionsView | null): view is ConnectionsView {
  return Boolean(view && view.canManage !== false && view.profiles.length >= 2);
}

/** Keeps a reconnecting environment's last known conversations instead of dropping them. */
function isTracked(phase: ConnectionPhase): boolean {
  return isEnvironmentConnected(phase) || phase === "reconnecting";
}

function emptyEnvironment(): RawEnvironment {
  return { loading: true, error: null, chats: {}, wisps: {}, runtime: createConversationRuntime(0, {}) };
}

/**
 * Activity labels for circles name the members whose turns run, as the
 * workspace does for the environment in use.
 */
export function circleActivityMap(
  runtime: ConversationRuntimeState,
  wisps: WispCollection,
): Record<string, string | undefined> {
  const turns = Object.entries(runtime.turns).filter(([, wispIds]) => wispIds?.length);
  if (!turns.length) return runtime.activity;
  const result = { ...runtime.activity };
  for (const [conversationId, wispIds] of turns) {
    const names = wispIds!.flatMap((wispId) => wisps[wispId]?.name ?? []);
    const [name] = names;
    if (!name) continue;
    if (names.length > 1) {
      result[conversationId] = `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are working…`;
      continue;
    }
    const label = runtime.activity[conversationId];
    result[conversationId] = label ? `${name} · ${label}` : `${name} is working…`;
  }
  return result;
}

function applyEvent(existing: RawEnvironment, type: string, payload: unknown): RawEnvironment {
  if (type === "agentEvent") {
    const runtime = reduceConversationAgentEvent(existing.runtime, payload as SequencedConversationAgentEvent, {
      chats: existing.chats,
      windows: {},
    });
    return runtime === existing.runtime ? existing : { ...existing, runtime };
  }
  if (type === "conversationChanged") {
    const delta = payload as ConversationDelta;
    if (!existing.chats[delta.chat.id]) return existing;
    return { ...existing, chats: { ...existing.chats, [delta.chat.id]: delta.chat } };
  }
  if (type === "wispsChanged") {
    const view = payload as WispsView;
    const runtime = reconcileConversationRuntime(existing.runtime, view.chats, view.statuses);
    return { ...existing, chats: view.chats, wisps: view.wisps, runtime };
  }
  return existing;
}

/**
 * Tracks the conversations of every connected environment, so the sidebar and
 * Team list them together. It lives above the workspace, which remounts when
 * the environment in use changes, so switching does not reload what it knows.
 * Each environment costs one `getConversationState` when it connects; pushed
 * `connectionEvent`s keep it current after that.
 */
export function EnvironmentDirectoryProvider({ children }: { children: ReactNode }) {
  const view = useContext(ActiveConnectionContext);
  const enabled = isMultiEnvironment(view);
  const [raw, setRaw] = useState<Record<string, RawEnvironment>>({});
  /** Environments loaded since they last connected; a reconnect loads them again. */
  const loaded = useRef(new Set<string>());
  const generations = useRef(new Map<string, number>());

  const phases = useMemo(() => {
    if (!enabled) return [] as ReadonlyArray<readonly [string, ConnectionPhase]>;
    return view.profiles.map((profile) => [profile.id, environmentPhase(view, profile.id)] as const);
  }, [enabled, view]);
  const phasesKey = phases.map(([id, phase]) => `${id}=${phase}`).join("\0");

  useEffect(() => {
    // A bridge that predates pooled environments has no scoped events.
    if (!enabled || typeof window.wisp.subscribeToConnectionEvents !== "function") return;
    return window.wisp.subscribeToConnectionEvents((event) => {
      setRaw((current) => {
        const existing = current[event.connectionId];
        if (!existing) return current;
        const next = applyEvent(existing, event.type, event.payload);
        return next === existing ? current : { ...current, [event.connectionId]: next };
      });
    });
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: phasesKey stands for phases.
  useEffect(() => {
    if (!enabled) {
      loaded.current.clear();
      setRaw((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    const connected = phases.filter(([, phase]) => isEnvironmentConnected(phase)).map(([id]) => id);
    const tracked = new Set(phases.filter(([, phase]) => isTracked(phase)).map(([id]) => id));
    for (const [id, phase] of phases) {
      if (!isEnvironmentConnected(phase)) loaded.current.delete(id);
    }
    const toLoad = connected.filter((id) => !loaded.current.has(id));
    for (const id of toLoad) loaded.current.add(id);

    setRaw((current) => {
      const next: Record<string, RawEnvironment> = {};
      for (const id of tracked) next[id] = current[id] ?? emptyEnvironment();
      const unchanged =
        Object.keys(next).length === Object.keys(current).length && Object.keys(next).every((id) => current[id]);
      return unchanged ? current : next;
    });

    for (const id of toLoad) {
      const generation = (generations.current.get(id) ?? 0) + 1;
      generations.current.set(id, generation);
      void loadEnvironment(id).then((result) => {
        // A reconnect started a newer load; its snapshot wins.
        if (generations.current.get(id) !== generation) return;
        setRaw((current) => {
          const existing = current[id];
          if (!existing) return current;
          if (!result.ok) return { ...current, [id]: { ...existing, loading: false, error: result.message } };
          return { ...current, [id]: result.value };
        });
      });
    }
  }, [enabled, phasesKey]);

  const environments = useMemo<ReadonlyArray<DirectoryEnvironment>>(() => {
    if (!enabled) return [];
    return view.profiles.flatMap((profile) => {
      const entry = raw[profile.id];
      if (!entry) return [];
      return [
        {
          profile,
          phase: environmentPhase(view, profile.id),
          loading: entry.loading,
          error: entry.error,
          chats: chatViews(entry.chats, entry.wisps),
          wisps: entry.wisps,
          statuses: entry.runtime.statuses,
          approvals: entry.runtime.approvals,
          activity: circleActivityMap(entry.runtime, entry.wisps),
        },
      ];
    });
  }, [enabled, view, raw]);

  const value = useMemo(() => (enabled ? { enabled, environments } : DISABLED), [enabled, environments]);
  return <EnvironmentDirectoryContext.Provider value={value}>{children}</EnvironmentDirectoryContext.Provider>;
}

async function loadEnvironment(
  id: string,
): Promise<{ ok: true; value: RawEnvironment } | { ok: false; message: string }> {
  try {
    // Always routed by ID, even for the environment in use, so the directory never depends on which one is active.
    const result = await createEnvironmentApi(id, undefined).getConversationState();
    if (!result.ok) return { ok: false, message: result.error.message };
    const state = result.value;
    return {
      ok: true,
      value: {
        loading: false,
        error: null,
        chats: Object.fromEntries(Object.entries(state.chats).map(([chatId, chat]) => [chatId, chatSummary(chat)])),
        wisps: state.wisps,
        runtime: createConversationRuntime(
          state.agentEventSequence,
          state.statuses,
          state.pendingToolApprovals,
          state.liveMessages,
        ),
      },
    };
  } catch {
    return { ok: false, message: "Could not load this environment's conversations." };
  }
}

export function useEnvironmentDirectory(): EnvironmentDirectoryValue {
  return useContext(EnvironmentDirectoryContext);
}
