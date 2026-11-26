import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { ChatView, ChatViewCollection } from "@/chat-data";
import { environmentPhase, isEnvironmentConnected } from "@/components/settings/settings-environment-selector";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { isMultiEnvironment, useEnvironmentDirectory } from "@/features/environments/environment-directory";
import { createEnvironmentApi } from "@/lib/environment-api";
import { openEnvironmentChat } from "@/lib/pending-environment-open";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionPhase,
  type ConnectionProfileView,
  type ConnectionsView,
} from "../../shared/connections";
import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import type { ManagedConversationStatus, WispCollection } from "../../shared/conversations";
import { isJobFinished, type JobsView } from "../../shared/jobs";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

/** `home` is This computer (or the browser's only server); `all` adds every other environment. */
export type TeamScope = "home" | "all";

export interface ActiveWorkspaceSnapshot {
  chats: ChatViewCollection;
  wisps: WispCollection;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
}

export interface TeamEnvironmentEntry {
  profile: ConnectionProfileView;
  isActive: boolean;
  phase: ConnectionPhase;
  connected: boolean;
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

interface EnvironmentMeta {
  defaultModelName: string | null;
  conversationModels: Record<string, string | null>;
  jobCounts: Record<string, number>;
}

const EMPTY_META: EnvironmentMeta = { defaultModelName: null, conversationModels: {}, jobCounts: {} };

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

function withoutApprovals(
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>,
  resolved: ReadonlySet<string>,
): Record<string, ReadonlyArray<ToolApprovalRequest>> {
  if (!resolved.size) return approvals;
  const next: Record<string, ReadonlyArray<ToolApprovalRequest>> = {};
  for (const [conversationId, requests] of Object.entries(approvals)) {
    const remaining = requests.filter((request) => !resolved.has(request.approvalId));
    if (remaining.length) next[conversationId] = remaining;
  }
  return next;
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
 * Conversations come from `activeWorkspace` for the environment in use and from
 * the environment directory for the others. Model names and job counts are
 * fetched only for the environments in scope, since they cost a call per Wisp.
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
  const directory = useEnvironmentDirectory();
  const activeId = connectionsView?.activeId ?? LOCAL_CONNECTION_ID;
  const profiles: ReadonlyArray<ConnectionProfileView> = useMemo(
    () => (connectionsView?.profiles.length ? connectionsView.profiles : [DEFAULT_LOCAL_PROFILE]),
    [connectionsView?.profiles],
  );
  const canShowAllEnvironments = isMultiEnvironment(connectionsView);
  /** With several environments, Team's own scope is always This computer, whichever one is in use. */
  const homeId = canShowAllEnvironments ? LOCAL_CONNECTION_ID : activeId;
  const [meta, setMeta] = useState<Record<string, EnvironmentMeta>>({});
  // Decisions sent from here hide their approval until the environment confirms it.
  const [resolvedApprovals, setResolvedApprovals] = useState<ReadonlySet<string>>(() => new Set());

  const environments: ReadonlyArray<TeamEnvironmentEntry> = useMemo(() => {
    const listed = new Map(directory.environments.map((entry) => [entry.profile.id, entry]));
    return profiles.map((profile) => {
      const isActive = profile.id === activeId;
      const phase: ConnectionPhase = connectionsView ? environmentPhase(connectionsView, profile.id) : "local";
      const connected = !connectionsView || isEnvironmentConnected(phase);
      const listedEntry = isActive ? undefined : listed.get(profile.id);
      const source = isActive
        ? { ...activeWorkspace, loading: false, error: null }
        : listedEntry && (connected || phase === "reconnecting")
          ? listedEntry
          : null;
      const envMeta = meta[profile.id] ?? EMPTY_META;

      return {
        profile,
        isActive,
        phase,
        connected,
        loading: Boolean(source?.loading),
        error: source?.error ?? null,
        chats: source?.chats ?? {},
        wisps: source?.wisps ?? {},
        statuses: source?.statuses ?? {},
        activity: source?.activity ?? {},
        approvals: withoutApprovals(source?.approvals ?? {}, resolvedApprovals),
        defaultModelName: envMeta.defaultModelName,
        conversationModels: envMeta.conversationModels,
        jobCounts: envMeta.jobCounts,
      };
    });
  }, [profiles, activeId, connectionsView, activeWorkspace, directory.environments, meta, resolvedApprovals]);

  /** All environments means the connected ones, as in the sidebar; a reconnecting one keeps what it last showed. */
  const scopedEnvironments = useMemo(
    () =>
      scope === "all" && canShowAllEnvironments
        ? environments.filter((entry) => entry.connected || entry.phase === "reconnecting")
        : environments.filter((entry) => entry.profile.id === homeId),
    [scope, canShowAllEnvironments, environments, homeId],
  );

  /** Each environment in scope, with the Wisps whose models to name. */
  const metaTargetsKey = scopedEnvironments
    .filter((entry) => entry.connected && !entry.loading)
    .map((entry) => {
      const wispIds = Object.values(entry.chats)
        .filter((chat) => chat.kind === "wisp")
        .map((chat) => chat.id)
        .sort();
      return [entry.profile.id, ...wispIds].join("\u0001");
    })
    .join("\0");

  // Model names and scheduled job counts, only for the environments in scope.
  useEffect(() => {
    if (!metaTargetsKey) return;
    let cancelled = false;
    const unsubscribes: Array<() => void> = [];
    for (const target of metaTargetsKey.split("\0")) {
      const [envId, ...wispIds] = target.split("\u0001") as [string, ...string[]];
      const api = createEnvironmentApi(envId, activeId);
      const update = (changes: Partial<EnvironmentMeta>) => {
        if (cancelled) return;
        setMeta((current) => ({ ...current, [envId]: { ...(current[envId] ?? EMPTY_META), ...changes } }));
      };
      if (typeof api.subscribeToJobs === "function") {
        unsubscribes.push(api.subscribeToJobs((view) => update({ jobCounts: countActiveJobs(view) })));
      }
      void (async () => {
        const [aiResult, jobsResult] = await Promise.all([
          typeof api.getAiSettings === "function" ? api.getAiSettings().catch(() => null) : Promise.resolve(null),
          typeof api.getJobs === "function" ? api.getJobs().catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const aiSettings = aiResult?.ok ? aiResult.value : null;
        update({
          defaultModelName: formatModelName(aiSettings?.selection, aiSettings),
          jobCounts: jobsResult?.ok ? countActiveJobs(jobsResult.value) : {},
        });
        const conversationModels = await fetchConversationModels(api, wispIds, aiSettings);
        update({ conversationModels });
      })();
    }
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [metaTargetsKey, activeId]);

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
        const result = await createEnvironmentApi(environmentId, activeId).resolveToolApproval({
          approvalId: request.approvalId,
          conversationId: request.conversationId,
          toolCallId: request.toolCallId,
          decision,
        });
        if (!result.ok) return result.error.message;
        setResolvedApprovals((current) => new Set(current).add(request.approvalId));
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
      return openEnvironmentChat(environmentId, conversationId, options);
    },
    [activeId, onOpenActiveChat],
  );

  return {
    connectionsView: connectionsView as ConnectionsView | null,
    activeId,
    homeId,
    canShowAllEnvironments,
    scopedEnvironments,
    pendingApprovals,
    resolveApproval,
    openChat,
  };
}
