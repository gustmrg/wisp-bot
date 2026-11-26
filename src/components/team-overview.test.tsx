import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TeamOverview } from "@/components/team-overview";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { EnvironmentDirectoryProvider } from "@/features/environments/environment-directory";
import type { ActiveWorkspaceSnapshot } from "@/hooks/use-team-overview";
import { clearPendingEnvironmentOpen, consumePendingEnvironmentOpen } from "@/lib/pending-environment-open";
import { circleChatView, testWisp, wispChatView } from "@/test/chat-fixtures";
import type { ConnectionEventMessage, ConnectionsView } from "../../shared/connections";
import type { AiSettingsView } from "../../shared/contracts";
import type { ConversationStateView } from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";
import { WISP_COLORS } from "../../shared/wisp-appearance";

const LOCAL_PROFILE = { id: "local" as const, kind: "local" as const, name: "This computer", paired: true };
const SERVER_PROFILE = {
  id: "home",
  kind: "url" as const,
  name: "Home server",
  url: "https://test-host.invalid",
  paired: true,
};
const OFFLINE_PROFILE = {
  id: "lab",
  kind: "url" as const,
  name: "Lab server",
  url: "https://lab.test-host.invalid",
  paired: true,
};

const AI_SETTINGS: AiSettingsView = {
  selection: { providerId: "openrouter", modelId: "claude-sonnet" },
  auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
  fallback: { selection: null, unavailable: null },
  secureStorageAvailable: true,
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      credentialConfigured: true,
      models: [
        {
          id: "claude-sonnet",
          name: "Claude Sonnet",
          reasoning: false,
          thinkingLevels: ["off"],
          input: ["text"],
          contextWindow: 100_000,
          maxOutputTokens: 4_000,
        },
        {
          id: "gpt-mini",
          name: "GPT Mini",
          reasoning: false,
          thinkingLevels: ["off"],
          input: ["text"],
          contextWindow: 100_000,
          maxOutputTokens: 4_000,
        },
      ],
    },
  ],
  catalogError: null,
};

const atlasWisp = testWisp("atlas", {
  name: "Atlas",
  role: "Research",
  soul: "Investigates deeply",
  color: WISP_COLORS[0].value,
});
const betaWisp = testWisp("beta", { name: "Beta", role: "Design", soul: "Designs clearly" });
const crewCircle = circleChatView("crew", [atlasWisp, betaWisp], {
  name: "Launch Crew",
  description: "Weekly launch coordination",
});

const localApproval: ToolApprovalRequest = {
  approvalId: "approval-local",
  conversationId: "atlas",
  toolCallId: "tool-1",
  toolName: "write",
  category: "create_file",
  scope: { kind: "workspace_path", display: "notes.md" },
  summary: "Create notes.md",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const skillApproval: ToolApprovalRequest = {
  approvalId: "approval-skill",
  conversationId: "beta",
  toolCallId: "tool-2",
  toolName: "save_skill",
  category: "save_skill",
  scope: { kind: "skill", display: "triage" },
  summary: "Save skill triage",
  preview: "---\nname: triage\ndescription: Triage bugs\n---\nSteps",
  expiresAt: new Date(Date.now() + 65_000).toISOString(),
};

const remoteApproval: ToolApprovalRequest = {
  approvalId: "approval-remote",
  conversationId: "nova",
  toolCallId: "tool-remote",
  toolName: "edit",
  category: "modify_file",
  scope: { kind: "workspace_path", display: "deploy.sh" },
  summary: "Edit deploy.sh",
  expiresAt: new Date(Date.now() + 70_000).toISOString(),
};

const remoteState: ConversationStateView = {
  initialized: true,
  wisps: {
    nova: testWisp("nova", { name: "Nova", role: "Operations", soul: "Monitors servers" }),
  },
  chats: {
    nova: {
      id: "nova",
      kind: "wisp",
      wispId: "nova",
      notifyOnUpdatesEnabled: true,
      preview: "Checking logs",
      unread: true,
      messages: [],
    },
  },
  statuses: { nova: "working" },
  liveMessages: {},
  agentEventSequence: 1,
  pendingToolApprovals: [remoteApproval],
  recoveredCorruptState: false,
};

/** This computer's own state, as the directory loads it while a server is in use. */
const localState: ConversationStateView = {
  ...remoteState,
  wisps: { orion: testWisp("orion", { name: "Orion", role: "Writing", soul: "Writes plainly" }) },
  chats: {
    orion: {
      id: "orion",
      kind: "wisp",
      wispId: "orion",
      notifyOnUpdatesEnabled: true,
      preview: "Drafting",
      messages: [],
    },
  },
  statuses: { orion: "idle" },
  pendingToolApprovals: [],
};

function multiEnvView(overrides: Partial<ConnectionsView> = {}): ConnectionsView {
  return {
    activeId: "local",
    profiles: [LOCAL_PROFILE, SERVER_PROFILE, OFFLINE_PROFILE],
    status: { profileId: "local", phase: "local", epoch: 1 },
    secureStorageAvailable: true,
    environments: {
      local: {
        profileId: "local",
        phase: "local",
        workingWisps: 1,
        pendingApprovals: 1,
        unreadConversations: 1,
        wispCount: 2,
        circleCount: 1,
      },
      home: {
        profileId: "home",
        phase: "connected",
        workingWisps: 1,
        pendingApprovals: 1,
        unreadConversations: 1,
        wispCount: 1,
        circleCount: 0,
      },
      lab: {
        profileId: "lab",
        phase: "choosing",
        workingWisps: 0,
        pendingApprovals: 0,
        unreadConversations: 0,
        wispCount: 0,
        circleCount: 0,
      },
    },
    ...overrides,
  };
}

function activeWorkspace(overrides: Partial<ActiveWorkspaceSnapshot> = {}): ActiveWorkspaceSnapshot {
  return {
    wisps: { atlas: atlasWisp, beta: betaWisp },
    chats: {
      atlas: wispChatView("atlas", { wisp: atlasWisp, chat: { unread: true } }),
      beta: wispChatView("beta", { wisp: betaWisp }),
      crew: crewCircle,
    },
    statuses: { atlas: "working", beta: "idle", crew: "idle" },
    activity: { atlas: "Searching the web…" },
    approvals: { atlas: [localApproval] },
    ...overrides,
  };
}

const connectionEventListeners = new Set<(event: ConnectionEventMessage) => void>();
const invokeConnectionOperation = vi.fn();
const activateConnection = vi.fn();
const getAiSettings = vi.fn();
const getJobs = vi.fn();
const getConversationModel = vi.fn();

beforeEach(() => {
  clearPendingEnvironmentOpen();
  connectionEventListeners.clear();

  getAiSettings.mockReset().mockResolvedValue({ ok: true, value: AI_SETTINGS });
  getJobs.mockReset().mockResolvedValue({
    ok: true,
    value: {
      jobs: [
        {
          id: "job-1",
          conversationId: "atlas",
          title: "Daily digest",
          instructions: "Summarize",
          skills: [],
          tools: [],
          schedule: { kind: "daily", time: "09:00" },
          timeZone: "UTC",
          nextRunAt: "2026-12-01T09:00:00.000Z",
          state: "",
          runCount: 0,
          consecutiveFailures: 0,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    },
  });
  getConversationModel.mockReset().mockImplementation(async ({ conversationId }: { conversationId: string }) => ({
    ok: true,
    value: {
      override: conversationId === "beta" ? { providerId: "openrouter", modelId: "gpt-mini" } : null,
      effective: { providerId: "openrouter", modelId: conversationId === "beta" ? "gpt-mini" : "claude-sonnet" },
      applied: null,
      pending: null,
      fallback: "global",
      status: "idle",
    },
  }));
  activateConnection.mockReset().mockResolvedValue({ ok: true, value: multiEnvView({ activeId: "home" }) });
  invokeConnectionOperation
    .mockReset()
    .mockImplementation(async ({ connectionId, operation }: { connectionId: string; operation: string }) => {
      if (operation === "getConversationState") {
        return { ok: true, value: connectionId === "local" ? localState : remoteState };
      }
      if (operation === "getAiSettings") return { ok: true, value: AI_SETTINGS };
      if (operation === "getJobs") return { ok: true, value: { jobs: [] } };
      if (operation === "getConversationModel") {
        return {
          ok: true,
          value: {
            override: null,
            effective: { providerId: "openrouter", modelId: "claude-sonnet" },
            applied: null,
            pending: null,
            fallback: "global",
            status: "working",
          },
        };
      }
      if (operation === "resolveToolApproval") return { ok: true, value: {} };
      return { ok: true, value: {} };
    });

  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings,
      getJobs,
      getConversationModel,
      getWispSetup: vi.fn(async () => ({
        ok: true,
        value: { maxQuotaBytes: 1024, runtime: { available: false, message: "none" } },
      })),
      activateConnection,
      invokeConnectionOperation,
      subscribeToJobs: vi.fn(() => () => undefined),
      subscribeToConnectionEvents: vi.fn((listener: (event: ConnectionEventMessage) => void) => {
        connectionEventListeners.add(listener);
        return () => connectionEventListeners.delete(listener);
      }),
    },
  });
});

function renderTeam({
  view = multiEnvView(),
  workspace = activeWorkspace(),
  onResolveActiveApproval = vi.fn(async () => true),
  onOpenActiveChat = vi.fn(),
  onCreateWisp = vi.fn(async () => "new-wisp"),
  onCreateCircle = vi.fn(async () => true),
}: {
  view?: ConnectionsView | null;
  workspace?: ActiveWorkspaceSnapshot;
  onResolveActiveApproval?: (request: ToolApprovalRequest, decision: "allow_once" | "deny") => Promise<boolean>;
  onOpenActiveChat?: (conversationId: string, options?: { openDetails?: boolean }) => void;
  onCreateWisp?: () => Promise<string | null>;
  onCreateCircle?: () => Promise<boolean>;
} = {}) {
  render(
    <ActiveConnectionContext.Provider value={view}>
      <EnvironmentDirectoryProvider>
        <TeamOverview
          activeWorkspace={workspace}
          onCreateWisp={onCreateWisp}
          onCreateCircle={onCreateCircle}
          onResolveActiveApproval={onResolveActiveApproval as never}
          onOpenActiveChat={onOpenActiveChat}
        />
      </EnvironmentDirectoryProvider>
    </ActiveConnectionContext.Provider>,
  );
  return { onResolveActiveApproval, onOpenActiveChat };
}

describe("TeamOverview", () => {
  it("shows This computer by default, and every connected environment's Wisps under All environments", async () => {
    const user = userEvent.setup();
    renderTeam();

    expect(screen.getByRole("heading", { name: "Team" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "This computer" })).toBeChecked();
    expect(screen.getByRole("button", { name: /^Atlas/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Launch Crew/ })).toBeVisible();

    // Model names and job count hydrate for the active environment.
    expect(await screen.findByText("Claude Sonnet")).toBeVisible();
    expect(screen.getByText("GPT Mini")).toBeVisible();
    expect(screen.getByText("1 job")).toBeVisible();

    // Model names cost a call per Wisp, so another environment's are asked for only once it is in scope.
    expect(invokeConnectionOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "home", operation: "getConversationModel" }),
    );

    await user.click(screen.getByRole("radio", { name: "All environments" }));
    expect(await screen.findByRole("button", { name: /^Nova/ })).toBeVisible();
    // Environments are managed in Settings: Team lists only what connected ones hold.
    expect(screen.queryByRole("heading", { name: "Environments" })).not.toBeInTheDocument();
    expect(screen.queryByText("Lab server")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(invokeConnectionOperation).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "home", operation: "getConversationModel" }),
      ),
    );
    expect(screen.queryByRole("button", { name: /to another environment/ })).not.toBeInTheDocument();

    // Live updates from subscribeToConnectionEvents update remote status.
    act(() => {
      for (const listener of connectionEventListeners) {
        listener({
          connectionId: "home",
          type: "agentEvent",
          payload: { sequence: 2, type: "conversation_status", conversationId: "nova", status: "idle" },
        });
      }
    });
    const novaArticle = screen.getByRole("button", { name: /^Nova/ }).closest("article")!;
    expect(within(novaArticle).getByText("Idle")).toBeVisible();
  });

  it("keeps This computer's Wisps under This computer while a server is in use", async () => {
    renderTeam({
      view: multiEnvView({ activeId: "home", status: { profileId: "home", phase: "connected", epoch: 1 } }),
      workspace: activeWorkspace({
        wisps: remoteState.wisps,
        chats: { nova: wispChatView("nova", { wisp: remoteState.wisps.nova! }) },
        statuses: { nova: "working" },
        activity: {},
        approvals: {},
      }),
    });

    expect(await screen.findByRole("button", { name: /^Orion/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Nova/ })).not.toBeInTheDocument();
  });

  it("hides the environment scope switch when only one environment exists", () => {
    renderTeam({
      view: multiEnvView({ profiles: [LOCAL_PROFILE] }),
    });
    expect(screen.queryByRole("radiogroup", { name: "Environment scope" })).not.toBeInTheDocument();
  });

  it("filters Wisps and circles by search, status pills, and kind", async () => {
    const user = userEvent.setup();
    renderTeam();

    await user.type(screen.getByRole("textbox", { name: "Search team" }), "launch");
    expect(screen.getByRole("button", { name: /^Launch Crew/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Atlas/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Search team" }));
    await user.click(screen.getByRole("button", { name: "Working" }));
    expect(screen.getByRole("button", { name: /^Atlas/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Beta/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Needs approval" }));
    expect(screen.getByRole("button", { name: /^Atlas/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Launch Crew/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Circles" }));
    expect(screen.getByText("No Wisps or circles match these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /^Beta/ })).toBeVisible();
  });

  it("resolves standard approvals directly, requires Review for save_skill, and resolves remote approvals via scoped API", async () => {
    const user = userEvent.setup();
    const { onResolveActiveApproval, onOpenActiveChat } = renderTeam({
      workspace: activeWorkspace({
        approvals: { atlas: [localApproval], beta: [skillApproval] },
      }),
    });

    const approvalsSection = screen.getByRole("region", { name: "Waiting for you" });
    const localCard = within(approvalsSection).getByRole("article", { name: "Atlas: Create notes.md" });
    await user.click(within(localCard).getByRole("button", { name: "Open" }));
    expect(onOpenActiveChat).toHaveBeenCalledWith("atlas", undefined);

    await user.click(within(localCard).getByRole("button", { name: "Allow once" }));
    expect(onResolveActiveApproval).toHaveBeenCalledWith(localApproval, "allow_once");

    // save_skill never shows a one-click Allow once button — it offers Review and Deny instead.
    const skillCard = within(approvalsSection).getByRole("article", { name: "Beta: Save skill triage" });
    expect(within(skillCard).queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    expect(within(skillCard).getByRole("button", { name: "Review" })).toBeVisible();

    // Switch to All environments and resolve the remote approval via invokeConnectionOperation.
    await user.click(screen.getByRole("radio", { name: "All environments" }));
    const remoteCard = await within(approvalsSection).findByRole("article", { name: "Nova: Edit deploy.sh" });
    await user.click(within(remoteCard).getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(invokeConnectionOperation).toHaveBeenCalledWith({
        connectionId: "home",
        operation: "resolveToolApproval",
        payload: {
          approvalId: "approval-remote",
          conversationId: "nova",
          toolCallId: "tool-remote",
          decision: "deny",
        },
      }),
    );
    await waitFor(() =>
      expect(within(approvalsSection).queryByRole("article", { name: "Nova: Edit deploy.sh" })).not.toBeInTheDocument(),
    );
  });

  it("opens a Wisp from another environment by switching to it and opening its conversation there", async () => {
    const user = userEvent.setup();
    renderTeam();

    await user.click(screen.getByRole("radio", { name: "All environments" }));
    await user.click(await screen.findByRole("button", { name: /^Nova/ }));

    expect(activateConnection).toHaveBeenCalledWith({ id: "home" });
    expect(consumePendingEnvironmentOpen("home")).toEqual(
      expect.objectContaining({ environmentId: "home", conversationId: "nova" }),
    );
  });

  it("opens the creation dialog directly on the Circle tab from New circle", async () => {
    const user = userEvent.setup();
    renderTeam();

    await user.click(screen.getByRole("button", { name: "New circle" }));
    expect(await screen.findByRole("heading", { name: "Create new circle" })).toBeVisible();
  });
});
