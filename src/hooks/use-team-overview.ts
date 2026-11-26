import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { ChatView, ChatViewCollection, WispChatView } from "@/chat-data";
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
import { clearPendingEnvironmentOpen, setPendingEnvironmentOpen } from "@/lib/pending-environment-open";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionPhase,
  type ConnectionProfileView,
  type ConnectionsView,
} from "../../shared/connections";
import type { AiSettingsView, ModelSelection, SequencedConversationAgentEvent } from "../../shared/contracts";
import {
  chatSummary,
  type ChatSummaryCollection,
  type ConversationDelta,
  type ManagedConversationStatus,
  type WispCollection,
  type WispsView,
} from "../../shared/conversations";
import { isJobFinished, type JobsView } from "../../shared/jobs";
import { formatSkillFile } from "../../shared/skills";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { serializeWispTemplate, type WispTemplate } from "../../shared/wisp-template";

export type TeamScope = "current" | "all";

export interface ActiveWorkspaceSnapshot {
  chats: ChatViewCollection;
  wisps: WispCollection;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
}

export interface TeamEnvironmentSummary {
  workingWisps: number;
  pendingApprovals: number;
  unreadConversations: number;
  wispCount: number;
  circleCount: number;
}

export interface TeamEnvironmentEntry {
  profile: ConnectionProfileView;
  isActive: boolean;
  phase: ConnectionPhase;
  connected: boolean;
  message?: string;
  serverVersion?: string;
  summary: TeamEnvironmentSummary;
  loading: boolean;
  error: string | null;
  chats: ChatViewCollection;
  wisps: WispCollection;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  defaultModelName: string | null;
  conversationModels: Record<string, string | null>;
  jobCounts: Record<string, number>;
}

export interface TeamApprovalItem {
  environmentId: string;
  environmentName: string;
  environmentKind: ConnectionProfileView["kind"];
  isActiveEnvironment: boolean;
  chat: ChatView;
  request: ToolApprovalRequest;
}

interface RemoteEnvState {
  loading: boolean;
  error: string | null;
  chats: ChatSummaryCollection;
  wisps: WispCollection;
  runtime: ConversationRuntimeState;
  defaultModelName: string | null;
  conversationModels: Record<string, string | null>;
  jobCounts: Record<string, number>;
}

interface ActiveEnvMeta {
  defaultModelName: string | null;
  conversationModels: Record<string, string | null>;
  jobCounts: Record<string, number>;
}

const DEFAULT_LOCAL_PROFILE: ConnectionProfileView = {
  id: LOCAL_CONNECTION_ID,
  kind: "local",
  name: "This computer",
  paired: true,
};

function formatModelName(
  selection: ModelSelection | null | undefined,
  aiSettings: AiSettingsView | null | undefined,
): string | null {
  if (!selection) return null;
  const provider = aiSettings?.providers.find((entry) => entry.id === selection.providerId);
  const model = provider?.models.find((entry) => entry.id === selection.modelId);
  return model?.name ?? selection.modelId;
}

function countActiveJobs(view: JobsView | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of view?.jobs ?? []) {
    if (isJobFinished(job)) continue;
    counts[job.conversationId] = (counts[job.conversationId] ?? 0) + 1;
  }
  return counts;
}

function summarizeWorkspace(
  chats: ChatViewCollection,
  statuses: Record<string, ManagedConversationStatus>,
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>,
): TeamEnvironmentSummary {
  let workingWisps = 0;
  let pendingApprovals = 0;
  let unreadConversations = 0;
  let wispCount = 0;
  let circleCount = 0;
  for (const chat of Object.values(chats)) {
    if (chat.kind === "wisp") wispCount += 1;
    else circleCount += 1;
    if (statuses[chat.id] === "working") workingWisps += 1;
    if (chat.unread) unreadConversations += 1;
    pendingApprovals += approvals[chat.id]?.length ?? 0;
  }
  return { workingWisps, pendingApprovals, unreadConversations, wispCount, circleCount };
}

function removeApprovalFromMap(
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>,
  conversationId: string,
  approvalId: string,
): Record<string, ReadonlyArray<ToolApprovalRequest>> {
  const existing = approvals[conversationId];
  if (!existing?.length) return approvals;
  const remaining = existing.filter((entry) => entry.approvalId !== approvalId);
  if (remaining.length === existing.length) return approvals;
  const next = { ...approvals };
  if (remaining.length) next[conversationId] = remaining;
  else delete next[conversationId];
  return next;
}

function circleActivityMap(
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

async function fetchConversationModels(
  api: ReturnType<typeof createEnvironmentApi>,
  wispIds: ReadonlyArray<string>,
  aiSettings: AiSettingsView | null,
): Promise<Record<string, string | null>> {
  if (!wispIds.length || typeof api.getConversationModel !== "function") return {};
  const entries = await Promise.all(
    wispIds.map(async (conversationId) => {
      try {
        const result = await api.getConversationModel({ conversationId });
        if (!result.ok) return [conversationId, null] as const;
        const selection = result.value.override ?? result.value.effective;
        return [conversationId, formatModelName(selection, aiSettings)] as const;
      } catch {
        return [conversationId, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Loads and maintains live data for the **Team** overview screen.
 *
 * Reuses `activeWorkspace` for the active environment and only fetches +
 * subscribes (`subscribeToConnectionEvents`) to other connected environments
 * when `scope === "all"`, keeping background traffic minimal.
 */
export function useTeamOverview({
  scope,
  activeWorkspace,
  onResolveActiveApproval,
  onOpenActiveChat,
}: {
  scope: TeamScope;
  activeWorkspace: ActiveWorkspaceSnapshot;
  onResolveActiveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
  onOpenActiveChat: (conversationId: string, options?: { openDetails?: boolean }) => void;
}) {
  const connectionsView = useContext(ActiveConnectionContext);
  const activeId = connectionsView?.activeId ?? LOCAL_CONNECTION_ID;
  const profiles: ReadonlyArray<ConnectionProfileView> = useMemo(
    () => (connectionsView?.profiles.length ? connectionsView.profiles : [DEFAULT_LOCAL_PROFILE]),
    [connectionsView?.profiles],
  );
  const canShowAllEnvironments = Boolean(
    connectionsView && connectionsView.canManage !== false && connectionsView.profiles.length >= 2,
  );

  const [activeMeta, setActiveMeta] = useState<ActiveEnvMeta>({
    defaultModelName: null,
    conversationModels: {},
    jobCounts: {},
  });
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteEnvState>>({});
  const remoteStatesRef = useRef(remoteStates);
  remoteStatesRef.current = remoteStates;

  const activeWispIds = useMemo(
    () =>
      Object.values(activeWorkspace.chats)
        .filter((chat) => chat.kind === "wisp")
        .map((chat) => chat.id)
        .sort(),
    [activeWorkspace.chats],
  );
  const activeWispIdsKey = activeWispIds.join("\0");

  // Load supplementary metadata (model names and scheduled job counts) for the active environment.
  useEffect(() => {
    let cancelled = false;
    const api = createEnvironmentApi(activeId, activeId);
    const wispIds = activeWispIdsKey ? activeWispIdsKey.split("\0") : [];

    const unsubscribeJobs =
      typeof api.subscribeToJobs === "function"
        ? api.subscribeToJobs((view) => {
            if (cancelled) return;
            setActiveMeta((current) => ({ ...current, jobCounts: countActiveJobs(view) }));
          })
        : () => undefined;

    void (async () => {
      const [aiResult, jobsResult] = await Promise.all([
        typeof api.getAiSettings === "function" ? api.getAiSettings().catch(() => null) : Promise.resolve(null),
        typeof api.getJobs === "function" ? api.getJobs().catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const aiSettings = aiResult?.ok ? aiResult.value : null;
      const defaultModelName = formatModelName(aiSettings?.selection, aiSettings);
      const jobCounts = jobsResult?.ok ? countActiveJobs(jobsResult.value) : {};
      setActiveMeta((current) => ({ ...current, defaultModelName, jobCounts }));

      const conversationModels = await fetchConversationModels(api, wispIds, aiSettings);
      if (cancelled) return;
      setActiveMeta((current) => ({ ...current, defaultModelName, conversationModels }));
    })();

    return () => {
      cancelled = true;
      unsubscribeJobs();
    };
  }, [activeId, activeWispIdsKey]);

  const otherConnectedIds = useMemo(() => {
    if (!connectionsView || connectionsView.canManage === false) return [];
    return connectionsView.profiles
      .filter(
        (profile) => profile.id !== activeId && isEnvironmentConnected(environmentPhase(connectionsView, profile.id)),
      )
      .map((profile) => profile.id);
  }, [connectionsView, activeId]);
  const otherConnectedKey = otherConnectedIds.join("\0");

  // Fetch and subscribe to other connected environments ONLY while "All environments" is selected.
  useEffect(() => {
    if (scope !== "all" || !otherConnectedKey) return;
    let cancelled = false;
    const targetIds = otherConnectedKey.split("\0");
    const targetSet = new Set(targetIds);

    setRemoteStates((current) => {
      const next: Record<string, RemoteEnvState> = {};
      for (const id of targetIds) {
        next[id] = current[id] ?? {
          loading: true,
          error: null,
          chats: {},
          wisps: {},
          runtime: createConversationRuntime(0, {}),
          defaultModelName: null,
          conversationModels: {},
          jobCounts: {},
        };
      }
      return next;
    });

    const unsubscribeEvents =
      typeof window.wisp?.subscribeToConnectionEvents === "function"
        ? window.wisp.subscribeToConnectionEvents((event) => {
            if (cancelled || !targetSet.has(event.connectionId)) return;
            const envId = event.connectionId;
            setRemoteStates((current) => {
              const existing = current[envId];
              if (!existing) return current;
              if (event.type === "agentEvent") {
                const nextRuntime = reduceConversationAgentEvent(
                  existing.runtime,
                  event.payload as SequencedConversationAgentEvent,
                  { chats: existing.chats, windows: {} },
                );
                if (nextRuntime === existing.runtime) return current;
                return { ...current, [envId]: { ...existing, runtime: nextRuntime } };
              }
              if (event.type === "conversationChanged") {
                const delta = event.payload as ConversationDelta;
                if (!existing.chats[delta.chat.id]) return current;
                return {
                  ...current,
                  [envId]: { ...existing, chats: { ...existing.chats, [delta.chat.id]: delta.chat } },
                };
              }
              if (event.type === "wispsChanged") {
                const view = event.payload as WispsView;
                const nextRuntime = reconcileConversationRuntime(existing.runtime, view.chats, view.statuses);
                return {
                  ...current,
                  [envId]: { ...existing, chats: view.chats, wisps: view.wisps, runtime: nextRuntime },
                };
              }
              if (event.type === "jobsChanged") {
                return {
                  ...current,
                  [envId]: { ...existing, jobCounts: countActiveJobs(event.payload as JobsView) },
                };
              }
              return current;
            });
          })
        : () => undefined;

    for (const envId of targetIds) {
      const api = createEnvironmentApi(envId, activeId);
      void (async () => {
        try {
          const [stateResult, aiResult, jobsResult] = await Promise.all([
            api.getConversationState(),
            typeof api.getAiSettings === "function" ? api.getAiSettings().catch(() => null) : Promise.resolve(null),
            typeof api.getJobs === "function" ? api.getJobs().catch(() => null) : Promise.resolve(null),
          ]);
          if (cancelled) return;
          if (!stateResult.ok) {
            setRemoteStates((current) => {
              const existing = current[envId];
              if (!existing) return current;
              return { ...current, [envId]: { ...existing, loading: false, error: stateResult.error.message } };
            });
            return;
          }
          const state = stateResult.value;
          const chats = Object.fromEntries(Object.entries(state.chats).map(([id, chat]) => [id, chatSummary(chat)]));
          const aiSettings = aiResult?.ok ? aiResult.value : null;
          const defaultModelName = formatModelName(aiSettings?.selection, aiSettings);
          const jobCounts = jobsResult?.ok ? countActiveJobs(jobsResult.value) : {};
          const runtime = createConversationRuntime(
            state.agentEventSequence,
            state.statuses,
            state.pendingToolApprovals,
            state.liveMessages,
          );
          setRemoteStates((current) => ({
            ...current,
            [envId]: {
              loading: false,
              error: null,
              chats,
              wisps: state.wisps,
              runtime,
              defaultModelName,
              conversationModels: current[envId]?.conversationModels ?? {},
              jobCounts,
            },
          }));

          const wispIds = Object.values(chats)
            .filter((chat) => chat.kind === "wisp")
            .map((chat) => chat.id);
          const conversationModels = await fetchConversationModels(api, wispIds, aiSettings);
          if (cancelled) return;
          setRemoteStates((current) => {
            const existing = current[envId];
            if (!existing) return current;
            return { ...current, [envId]: { ...existing, conversationModels } };
          });
        } catch {
          if (cancelled) return;
          setRemoteStates((current) => {
            const existing = current[envId];
            if (!existing) return current;
            return { ...current, [envId]: { ...existing, loading: false, error: "Could not load environment state." } };
          });
        }
      })();
    }

    return () => {
      cancelled = true;
      unsubscribeEvents();
    };
  }, [scope, activeId, otherConnectedKey]);

  const environments: ReadonlyArray<TeamEnvironmentEntry> = useMemo(() => {
    const activeSummary = summarizeWorkspace(
      activeWorkspace.chats,
      activeWorkspace.statuses,
      activeWorkspace.approvals,
    );

    return profiles.map((profile) => {
      const isActive = profile.id === activeId;
      const phase: ConnectionPhase = connectionsView ? environmentPhase(connectionsView, profile.id) : "local";
      const connected = !connectionsView || isEnvironmentConnected(phase);
      const envInfo = connectionsView?.environments?.[profile.id];

      if (isActive) {
        return {
          profile,
          isActive: true,
          phase,
          connected,
          message: envInfo?.message ?? connectionsView?.status.message,
          serverVersion: envInfo?.serverVersion ?? connectionsView?.status.serverVersion,
          summary: activeSummary,
          loading: false,
          error: null,
          chats: activeWorkspace.chats,
          wisps: activeWorkspace.wisps,
          statuses: activeWorkspace.statuses,
          activity: activeWorkspace.activity,
          approvals: activeWorkspace.approvals,
          defaultModelName: activeMeta.defaultModelName,
          conversationModels: activeMeta.conversationModels,
          jobCounts: activeMeta.jobCounts,
        };
      }

      const remote = scope === "all" && connected ? remoteStates[profile.id] : undefined;
      const chats = remote ? chatViews(remote.chats, remote.wisps) : {};
      const statuses = remote?.runtime.statuses ?? {};
      const approvals = remote?.runtime.approvals ?? {};
      const activity = remote ? circleActivityMap(remote.runtime, remote.wisps) : {};
      const loadedSummary = remote && !remote.loading ? summarizeWorkspace(chats, statuses, approvals) : null;

      return {
        profile,
        isActive: false,
        phase,
        connected,
        message: envInfo?.message,
        serverVersion: envInfo?.serverVersion,
        summary: loadedSummary ?? {
          workingWisps: envInfo?.workingWisps ?? 0,
          pendingApprovals: envInfo?.pendingApprovals ?? 0,
          unreadConversations: envInfo?.unreadConversations ?? 0,
          wispCount: envInfo?.wispCount ?? 0,
          circleCount: envInfo?.circleCount ?? 0,
        },
        loading: Boolean(remote?.loading),
        error: remote?.error ?? null,
        chats,
        wisps: remote?.wisps ?? {},
        statuses,
        activity,
        approvals,
        defaultModelName: remote?.defaultModelName ?? null,
        conversationModels: remote?.conversationModels ?? {},
        jobCounts: remote?.jobCounts ?? {},
      };
    });
  }, [profiles, activeId, connectionsView, activeWorkspace, activeMeta, scope, remoteStates]);

  const scopedEnvironments = useMemo(
    () => (scope === "all" && canShowAllEnvironments ? environments : environments.filter((entry) => entry.isActive)),
    [scope, canShowAllEnvironments, environments],
  );

  const connectedEnvironments = useMemo(
    () => environments.filter((entry) => entry.connected).map((entry) => entry.profile),
    [environments],
  );

  const pendingApprovals = useMemo<ReadonlyArray<TeamApprovalItem>>(() => {
    const items: TeamApprovalItem[] = [];
    for (const env of scopedEnvironments) {
      for (const requests of Object.values(env.approvals)) {
        for (const request of requests) {
          const chat = env.chats[request.conversationId];
          if (!chat) continue;
          items.push({
            environmentId: env.profile.id,
            environmentName: env.profile.name,
            environmentKind: env.profile.kind,
            isActiveEnvironment: env.isActive,
            chat,
            request,
          });
        }
      }
    }
    return items.sort((left, right) => Date.parse(right.request.expiresAt) - Date.parse(left.request.expiresAt));
  }, [scopedEnvironments]);

  const resolveApproval = useCallback(
    async (
      environmentId: string,
      request: ToolApprovalRequest,
      decision: ToolApprovalDecision,
    ): Promise<string | null> => {
      if (environmentId === activeId) {
        const ok = await onResolveActiveApproval(request, decision);
        return ok ? null : "Could not send your decision. Try again.";
      }
      try {
        const api = createEnvironmentApi(environmentId, activeId);
        const result = await api.resolveToolApproval({
          approvalId: request.approvalId,
          conversationId: request.conversationId,
          toolCallId: request.toolCallId,
          decision,
        });
        if (!result.ok) return result.error.message;
        setRemoteStates((current) => {
          const existing = current[environmentId];
          if (!existing) return current;
          return {
            ...current,
            [environmentId]: {
              ...existing,
              runtime: {
                ...existing.runtime,
                approvals: removeApprovalFromMap(
                  existing.runtime.approvals,
                  request.conversationId,
                  request.approvalId,
                ),
              },
            },
          };
        });
        return null;
      } catch {
        return "Could not send your decision. Try again.";
      }
    },
    [activeId, onResolveActiveApproval],
  );

  const openChat = useCallback(
    async (
      environmentId: string,
      conversationId: string,
      options?: { openDetails?: boolean },
    ): Promise<string | null> => {
      if (environmentId === activeId) {
        onOpenActiveChat(conversationId, options);
        return null;
      }
      setPendingEnvironmentOpen({
        environmentId,
        conversationId,
        ...(options?.openDetails ? { openDetails: true } : {}),
      });
      try {
        const result = await window.wisp.activateConnection({ id: environmentId });
        if (!result.ok) {
          clearPendingEnvironmentOpen();
          return result.error.message;
        }
        return null;
      } catch {
        clearPendingEnvironmentOpen();
        return "The environment could not be switched.";
      }
    },
    [activeId, onOpenActiveChat],
  );

  const switchEnvironment = useCallback(async (environmentId: string): Promise<string | null> => {
    try {
      const result = await window.wisp.activateConnection({ id: environmentId });
      return result.ok ? null : result.error.message;
    } catch {
      return "The environment could not be switched.";
    }
  }, []);

  const connectEnvironment = useCallback(async (environmentId: string): Promise<string | null> => {
    try {
      const result = await window.wisp.connectEnvironment({ id: environmentId });
      return result.ok ? null : result.error.message;
    } catch {
      return "Could not connect to the environment.";
    }
  }, []);

  /**
   * Copies only the Wisp's credential-free, grant-free definition (name, role,
   * soul, appearance, color, skills) as a template in the target environment
   * (ADR 040). Never copies credentials, access grants, or history.
   */
  const copyWispToEnvironment = useCallback(
    async (sourceEnvironmentId: string, chat: WispChatView, target: ConnectionProfileView): Promise<string | null> => {
      try {
        const sourceApi = createEnvironmentApi(sourceEnvironmentId, activeId);
        const skillsResult =
          typeof sourceApi.listSkills === "function"
            ? await sourceApi.listSkills({ conversationId: chat.id }).catch(() => null)
            : null;
        const skills = skillsResult?.ok ? skillsResult.value : [];
        const template: WispTemplate = {
          name: chat.wisp.name,
          role: chat.wisp.role,
          soul: chat.wisp.soul,
          appearance: chat.wisp.appearance,
          ...(chat.wisp.color ? { color: chat.wisp.color } : {}),
          ...(skills.length ? { skills: skills.map((skill) => ({ contents: formatSkillFile(skill) })) } : {}),
        };
        const targetApi = createEnvironmentApi(target.id, activeId);
        const result = await targetApi.saveWispTemplate({ contents: serializeWispTemplate(template) });
        if (!result.ok) return result.error.message;
        return null;
      } catch {
        return `Could not copy ${chat.wisp.name} to ${target.name}.`;
      }
    },
    [activeId],
  );

  return {
    connectionsView: connectionsView as ConnectionsView | null,
    activeId,
    canShowAllEnvironments,
    environments,
    scopedEnvironments,
    connectedEnvironments,
    pendingApprovals,
    resolveApproval,
    openChat,
    switchEnvironment,
    connectEnvironment,
    copyWispToEnvironment,
  };
}
