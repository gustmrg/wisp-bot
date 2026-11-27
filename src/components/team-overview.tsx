import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClockIcon,
  ChevronLeftIcon,
  CpuIcon,
  LaptopIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react";

import type { ChatView, NewCircle, NewWisp, Wisp } from "@/chat-data";
import { ApprovalSheet } from "@/components/approval-summary";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateChatDialog } from "@/components/create-chat-dialog";
import { MobileNavigation } from "@/components/mobile-navigation";
import { StatusDot } from "@/components/settings/settings-primitives";
import { approvalAsk, needsReview } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { phaseTone } from "@/features/connections/connections-panel";
import {
  useTeamOverview,
  type ActiveWorkspaceSnapshot,
  type TeamApprovalItem,
  type TeamEnvironmentEntry,
  type TeamScope,
} from "@/hooks/use-team-overview";
import { approvalWispName, chatName } from "@/lib/chat-schema";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import type { ConnectionPhase, ConnectionProfileView } from "../../shared/connections";
import type { ModelSelection } from "../../shared/contracts";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

type StatusFilter = "all" | "working" | "approval" | "unread";
type KindFilter = "all" | "wisp" | "circle";

const SCOPE_OPTIONS: ReadonlyArray<{ value: TeamScope; label: string }> = [
  { value: "home", label: "This computer" },
  { value: "all", label: "All environments" },
];

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "approval", label: "Needs approval" },
  { value: "unread", label: "Unread" },
];

const KIND_OPTIONS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "wisp", label: "Wisps" },
  { value: "circle", label: "Circles" },
];

export interface TeamOverviewProps {
  mobile?: boolean;
  activeWorkspace: ActiveWorkspaceSnapshot;
  unreadCount?: number;
  approvalCount?: number;
  onCreateWisp: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<string | null>;
  onCreateCircle?: (circle: NewCircle) => Promise<boolean>;
  onOpenTemplates?: () => void;
  onResolveActiveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
  onOpenActiveChat: (conversationId: string, options?: { openDetails?: boolean }) => void;
  onConversations?: () => void;
  onOpenApprovals?: () => void;
  onOpenSettings?: () => void;
}

function ProfileIcon({ kind, className }: { kind: ConnectionProfileView["kind"]; className?: string }) {
  const Icon = kind === "local" ? LaptopIcon : ServerIcon;
  return <Icon aria-hidden="true" className={className} />;
}

function environmentPhaseText(phase: ConnectionPhase, profile: ConnectionProfileView): string {
  if (phase === "local" || phase === "connected") return "Connected";
  if (phase === "connecting") return "Connecting…";
  if (phase === "reconnecting") return "Reconnecting";
  if (phase === "pairing_required" || (profile.kind !== "local" && !profile.paired)) return "Not paired";
  return "Offline";
}

function requiresFullReview(request: ToolApprovalRequest): boolean {
  return needsReview(request) || Boolean(request.job || request.wisp || request.preview);
}

function matchesTeamFilter(
  chat: ChatView,
  query: string,
  statusFilter: StatusFilter,
  kindFilter: KindFilter,
  status: ManagedConversationStatus | undefined,
  pendingApprovalsCount: number,
): boolean {
  if (kindFilter !== "all" && chat.kind !== kindFilter) return false;
  if (statusFilter === "working" && status !== "working") return false;
  if (statusFilter === "approval" && pendingApprovalsCount === 0) return false;
  if (statusFilter === "unread" && !chat.unread) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (chat.kind === "wisp") {
    return [chat.wisp.name, chat.wisp.role].some((text) => text.toLowerCase().includes(needle));
  }
  return [chat.name, chat.description, ...chat.members.map((member) => member.name)].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/**
 * Main-panel **Team** overview screen showing pending approvals, saved
 * environments, and Wisps & circles across the active environment or all
 * connected environments.
 */
export function TeamOverview({
  mobile = false,
  activeWorkspace,
  unreadCount = 0,
  approvalCount = 0,
  onCreateWisp,
  onCreateCircle,
  onOpenTemplates,
  onResolveActiveApproval,
  onOpenActiveChat,
  onConversations,
  onOpenApprovals,
  onOpenSettings,
}: TeamOverviewProps) {
  const [scope, setScope] = useState<TeamScope>("home");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [createDialog, setCreateDialog] = useState<"wisp" | "circle" | null>(null);
  const [reviewingApproval, setReviewingApproval] = useState<TeamApprovalItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);

  const team = useTeamOverview({
    scope,
    activeWorkspace,
    onResolveActiveApproval,
    onOpenActiveChat,
  });

  useEffect(() => {
    if (mobile) titleRef.current?.focus();
  }, [mobile]);

  useEffect(() => {
    if (!team.canShowAllEnvironments && scope !== "home") setScope("home");
  }, [team.canShowAllEnvironments, scope]);

  const effectiveScope: TeamScope = team.canShowAllEnvironments ? scope : "home";
  const allWisps: ReadonlyArray<Wisp> = useMemo(
    () => Object.values(activeWorkspace.chats).flatMap((chat) => (chat.kind === "wisp" ? [chat.wisp] : [])),
    [activeWorkspace.chats],
  );

  const groupedChats = useMemo(() => {
    return team.scopedEnvironments.map((env) => {
      const items = Object.values(env.chats)
        .filter((chat) =>
          matchesTeamFilter(
            chat,
            query,
            statusFilter,
            kindFilter,
            env.statuses[chat.id],
            env.approvals[chat.id]?.length ?? 0,
          ),
        )
        .sort((left, right) => chatName(left).localeCompare(chatName(right)));
      return { env, items };
    });
  }, [team.scopedEnvironments, query, statusFilter, kindFilter]);

  const totalMatching = groupedChats.reduce((sum, group) => sum + group.items.length, 0);
  const totalAvailable = team.scopedEnvironments.reduce((sum, env) => sum + Object.keys(env.chats).length, 0);
  const hasFilters = Boolean(query.trim()) || statusFilter !== "all" || kindFilter !== "all";

  async function runAction(key: string, action: () => Promise<string | null>, successMessage?: string) {
    setBusyKey(key);
    setError("");
    if (successMessage) setNotice("");
    try {
      const failure = await action();
      if (failure) setError(failure);
      else if (successMessage) setNotice(successMessage);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <main className={cn(mainPanel, mobile && "w-full")} aria-labelledby="team-overview-title">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-6 max-[760px]:gap-5 max-[760px]:px-4 max-[760px]:py-4">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {mobile && onConversations ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to conversations"
                  onClick={onConversations}
                >
                  <ChevronLeftIcon aria-hidden="true" />
                </Button>
              ) : null}
              <h1
                id="team-overview-title"
                ref={titleRef}
                tabIndex={-1}
                className="m-0 text-xl font-semibold outline-none"
              >
                Team
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {team.canShowAllEnvironments ? (
                <SegmentedControl
                  label="Environment scope"
                  value={effectiveScope}
                  options={SCOPE_OPTIONS}
                  onChange={setScope}
                />
              ) : null}
              <Button type="button" size="sm" onClick={() => setCreateDialog("wisp")}>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                New Wisp
              </Button>
              {onCreateCircle ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setCreateDialog("circle")}>
                  <UsersIcon data-icon="inline-start" aria-hidden="true" />
                  New circle
                </Button>
              ) : null}
            </div>
          </header>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dim"
              />
              <Input
                aria-label="Search team"
                placeholder="Search Wisps and circles…"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map((option) => {
                const pressed = statusFilter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setStatusFilter(option.value)}
                    className={cn(
                      "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                      pressed
                        ? "border-foreground/15 bg-accent text-accent-foreground"
                        : "border-border bg-transparent text-dim hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <SegmentedControl
              label="Filter by kind"
              value={kindFilter}
              options={KIND_OPTIONS}
              onChange={setKindFilter}
            />
          </div>

          {notice ? (
            <p
              role="status"
              className="m-0 rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs text-foreground"
            >
              {notice}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="m-0 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}

          {team.pendingApprovals.length > 0 ? (
            <section aria-labelledby="team-approvals-heading" className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <ShieldAlertIcon aria-hidden="true" className="size-4 text-warning" />
                <h2 id="team-approvals-heading" className="m-0 text-sm font-semibold">
                  Waiting for you
                </h2>
                <span className="rounded-full bg-warning-solid/15 px-2 py-0.5 text-2xs font-semibold text-warning tabular-nums">
                  {team.pendingApprovals.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {team.pendingApprovals.map((item) => {
                  const wispName = approvalWispName(item.chat, item.request);
                  const needsDetails = requiresFullReview(item.request);
                  const approvalBusy = busyKey === `approval:${item.request.approvalId}`;
                  return (
                    <article
                      key={`${item.environmentId}:${item.request.approvalId}`}
                      aria-label={`${wispName}: ${item.request.summary}`}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-warning-solid/25 bg-card p-3.5"
                    >
                      <span className="wisp-halo flex-none" data-state="approval">
                        <ChatAvatar chat={item.chat} size="sm" state="approval" />
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <span className="font-semibold">{wispName}</span>
                          <span className="text-dim">{approvalAsk(item.request)}</span>
                          {effectiveScope === "all" ? (
                            <EnvironmentPill kind={item.environmentKind} name={item.environmentName} />
                          ) : null}
                        </div>
                        <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
                          {item.request.summary}
                        </code>
                      </div>
                      <div className="flex flex-none flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={approvalBusy}
                          onClick={() =>
                            void runAction(`open:${item.environmentId}:${item.chat.id}`, () =>
                              team.openChat(item.environmentId, item.chat.id),
                            )
                          }
                        >
                          Open
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={approvalBusy}
                          onClick={() =>
                            void runAction(`approval:${item.request.approvalId}`, () =>
                              team.resolveApproval(item.environmentId, item.request, "deny"),
                            )
                          }
                        >
                          Deny
                        </Button>
                        {needsDetails ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={approvalBusy}
                            onClick={() => setReviewingApproval(item)}
                          >
                            Review
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={approvalBusy}
                            onClick={() =>
                              void runAction(`approval:${item.request.approvalId}`, () =>
                                team.resolveApproval(item.environmentId, item.request, "allow_once"),
                              )
                            }
                          >
                            Allow once
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="team-members-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="team-members-heading" className="m-0 text-sm font-semibold">
                Wisps &amp; circles
              </h2>
              {totalAvailable > 0 ? (
                <span className="text-xs text-dim tabular-nums">
                  {hasFilters ? `${totalMatching} of ${totalAvailable}` : `${totalAvailable}`}
                </span>
              ) : null}
            </div>

            {effectiveScope === "home" && groupedChats[0] && !groupedChats[0].env.connected ? (
              <p role="status" className="m-0 text-xs text-dim">
                {groupedChats[0].env.profile.name} is starting. Its Wisps and circles appear once it is ready.
              </p>
            ) : totalMatching === 0 && hasFilters ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-8 text-center">
                <p className="m-0 text-sm text-dim">No Wisps or circles match these filters.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                    setKindFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : totalAvailable === 0 && !groupedChats.some((group) => group.env.loading) ? (
              <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border p-8 text-center">
                <p className="m-0 text-sm text-dim">No Wisps yet. Create one to start building your team.</p>
                <Button type="button" size="sm" onClick={() => setCreateDialog("wisp")}>
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  New Wisp
                </Button>
              </div>
            ) : effectiveScope === "all" ? (
              <div className="flex flex-col gap-5">
                {groupedChats.map(({ env, items }) => {
                  if (hasFilters && items.length === 0) return null;
                  return (
                    <div key={env.profile.id} className="flex flex-col gap-2.5">
                      <div className="flex items-center gap-2 text-xs text-dim">
                        <ProfileIcon kind={env.profile.kind} className="size-3.5 shrink-0" />
                        <span className="font-medium text-foreground">{env.profile.name}</span>
                        <StatusDot tone={phaseTone(env.phase)} />
                        <span>{environmentPhaseText(env.phase, env.profile)}</span>
                      </div>
                      {env.loading ? (
                        <p role="status" className="m-0 text-xs text-dim">
                          Loading Wisps and circles…
                        </p>
                      ) : env.error ? (
                        <p role="alert" className="m-0 text-xs text-destructive">
                          {env.error}
                        </p>
                      ) : items.length === 0 ? (
                        <p className="m-0 text-xs text-dim">No Wisps or circles in {env.profile.name}.</p>
                      ) : (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          {items.map((chat) => (
                            <TeamMemberCard
                              key={`${env.profile.id}:${chat.id}`}
                              env={env}
                              chat={chat}
                              showEnvironment
                              onOpen={() =>
                                void runAction(`open:${env.profile.id}:${chat.id}`, () =>
                                  team.openChat(env.profile.id, chat.id),
                                )
                              }
                              onOpenSettings={() =>
                                void runAction(`settings:${env.profile.id}:${chat.id}`, () =>
                                  team.openChat(env.profile.id, chat.id, { openDetails: true }),
                                )
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {groupedChats[0]?.items.map((chat) => {
                  const env = groupedChats[0]!.env;
                  return (
                    <TeamMemberCard
                      key={chat.id}
                      env={env}
                      chat={chat}
                      showEnvironment={false}
                      onOpen={() =>
                        void runAction(`open:${env.profile.id}:${chat.id}`, () =>
                          team.openChat(env.profile.id, chat.id),
                        )
                      }
                      onOpenSettings={() =>
                        void runAction(`settings:${env.profile.id}:${chat.id}`, () =>
                          team.openChat(env.profile.id, chat.id, { openDetails: true }),
                        )
                      }
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {mobile && onConversations && onOpenSettings ? (
        <MobileNavigation
          current="team"
          onConversations={onConversations}
          onApprovals={onOpenApprovals}
          onSettings={onOpenSettings}
          unreadCount={unreadCount}
          approvalCount={approvalCount}
        />
      ) : null}

      <CreateChatDialog
        open={createDialog !== null}
        initialKind={createDialog ?? "wisp"}
        onOpenChange={(open) => {
          if (!open) setCreateDialog(null);
        }}
        onCreate={onCreateWisp}
        onCreateCircle={onCreateCircle}
        wisps={allWisps}
        {...(onOpenTemplates ? { onOpenTemplates } : {})}
      />

      {reviewingApproval ? (
        <ApprovalSheet
          chat={reviewingApproval.chat}
          request={reviewingApproval.request}
          onResolve={(decision) => {
            const current = reviewingApproval;
            setReviewingApproval(null);
            void runAction(`approval:${current.request.approvalId}`, () =>
              team.resolveApproval(current.environmentId, current.request, decision),
            );
          }}
          onClose={() => setReviewingApproval(null)}
          onOpenChat={() => {
            const current = reviewingApproval;
            setReviewingApproval(null);
            void runAction(`open:${current.environmentId}:${current.chat.id}`, () =>
              team.openChat(current.environmentId, current.chat.id),
            );
          }}
        />
      ) : null}
    </main>
  );
}

function EnvironmentPill({ kind, name }: { kind: ConnectionProfileView["kind"]; name: string }) {
  return (
    <span className="inline-flex max-w-[180px] items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-dim">
      <ProfileIcon kind={kind} className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function TeamMemberCard({
  env,
  chat,
  showEnvironment,
  onOpen,
  onOpenSettings,
}: {
  env: TeamEnvironmentEntry;
  chat: ChatView;
  showEnvironment: boolean;
  onOpen: () => void;
  onOpenSettings: () => void;
}) {
  const name = chatName(chat);
  const status = env.statuses[chat.id];
  const working = status === "working";
  const pendingApprovalCount = env.approvals[chat.id]?.length ?? 0;
  const avatarState = pendingApprovalCount > 0 ? "approval" : working ? "working" : "idle";
  const activityText = env.activity[chat.id];
  const modelName = chat.kind === "wisp" ? (env.conversationModels[chat.id] ?? env.defaultModelName) : null;
  const jobCount = env.jobCounts[chat.id] ?? 0;
  const color = chat.kind === "wisp" ? wispColor(chat.wisp.name, chat.wisp.color) : undefined;
  const subtitle =
    chat.kind === "wisp"
      ? chat.wisp.role.trim()
      : [chat.description.trim(), `${chat.members.length} ${chat.members.length === 1 ? "member" : "members"}`]
          .filter(Boolean)
          .join(" · ");

  return (
    <article
      style={color ? wispAccentStyle(color) : undefined}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 transition-colors hover:border-foreground/20"
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          onClick={onOpen}
          className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative flex-none">
            <ChatAvatar chat={chat} state={avatarState} />
            {chat.unread ? (
              <span
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-[#ff3b30]"
                aria-hidden="true"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <strong className="truncate text-sm font-semibold">{name}</strong>
              {chat.kind === "circle" ? (
                <span className="rounded-full bg-muted px-1.5 py-px text-2xs font-medium text-dim">Circle</span>
              ) : null}
            </span>
            {subtitle ? <span className="block truncate text-xs text-dim">{subtitle}</span> : null}
          </span>
        </button>

        <div className="flex flex-none items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Settings for ${name}`}
            title={`Settings for ${name}`}
            onClick={onOpenSettings}
          >
            <SettingsIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-dim">
        {working ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">
            <LoaderCircleIcon aria-hidden="true" className="size-3 shrink-0 animate-spin" />
            <span className="truncate">{activityText ?? "Working…"}</span>
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-medium text-dim">
            {status === "configuration_required" ? "Needs setup" : "Idle"}
          </span>
        )}
        {pendingApprovalCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-solid/15 px-2 py-0.5 font-medium text-warning tabular-nums">
            <ShieldAlertIcon aria-hidden="true" className="size-3 shrink-0" />
            {pendingApprovalCount} {pendingApprovalCount === 1 ? "approval" : "approvals"}
          </span>
        ) : null}
        {chat.unread ? (
          <span className="inline-flex items-center rounded-full bg-[#ff3b30]/15 px-2 py-0.5 font-medium text-[#ff3b30]">
            Unread
          </span>
        ) : null}
        {modelName ? (
          <span className="inline-flex max-w-[180px] items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-dim">
            <CpuIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{modelName}</span>
          </span>
        ) : null}
        {jobCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-dim tabular-nums">
            <CalendarClockIcon aria-hidden="true" className="size-3 shrink-0" />
            {jobCount} {jobCount === 1 ? "job" : "jobs"}
          </span>
        ) : null}
        {showEnvironment ? <EnvironmentPill kind={env.profile.kind} name={env.profile.name} /> : null}
      </div>
    </article>
  );
}
