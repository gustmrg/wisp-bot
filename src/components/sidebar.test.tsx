import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSummaryCollection } from "@/chat-data";
import type { CurrentUser } from "@/config/app-metadata";
import { Sidebar } from "@/components/sidebar";

const currentUser: CurrentUser = {
  displayName: "Ada Lovelace",
  givenName: "Ada",
  initials: "AL",
};

const callbacks = {
  onCollapsedChange: vi.fn(),
  onCreate: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenSettings: vi.fn(),
  onResizeStart: vi.fn(),
  onSelectChat: vi.fn(),
};

beforeEach(() => {
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getAiSettings: vi.fn(async () => ({
        ok: true,
        value: { selection: null, secureStorageAvailable: true, providers: [] },
      })),
    },
  });
});

describe("Sidebar current user", () => {
  it("renders injected identity metadata", () => {
    render(
      <Sidebar activeChatId="" chats={{}} collapsed={false} currentUser={currentUser} width={280} {...callbacks} />,
    );

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("AL")).toBeVisible();
  });

  it("shows a user icon instead of initials when no name is set", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={{}}
        collapsed={false}
        currentUser={{ displayName: "Your profile", givenName: "", initials: "" }}
        width={280}
        {...callbacks}
      />,
    );

    const profile = screen.getByRole("button", { name: "Open user settings" });
    expect(profile.querySelector("svg.lucide-user")).toBeInTheDocument();
    expect(profile).not.toHaveTextContent("?");
  });

  it("opens a Wisp-only creation dialog without a kind selector", async () => {
    const user = userEvent.setup();
    render(
      <Sidebar activeChatId="" chats={{}} collapsed={false} currentUser={currentUser} width={280} {...callbacks} />,
    );

    const createButton = screen.getByRole("button", { name: "Create Wisp" });
    expect(createButton).toHaveClass("w-full", "text-base");
    expect(createButton).not.toHaveClass("w-fit");

    await user.click(createButton);

    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Creation type" })).not.toBeInTheDocument();
  });
});

describe("Sidebar approvals", () => {
  const chats: ChatSummaryCollection = {
    atlas: {
      id: "atlas",
      name: "Atlas",
      label: "Research",
      description: "Finds relevant information",
      kind: "wisp",
      shape: "circle",
      notifyOnUpdatesEnabled: true,
      preview: "Latest research",
      timestamp: "Now",
    },
  };
  const approvals = {
    atlas: [
      {
        approvalId: "approval-1",
        conversationId: "atlas",
        toolCallId: "tool-1",
        toolName: "write",
        category: "create_file" as const,
        scope: { kind: "workspace_path" as const, display: "notes.txt" },
        summary: "Create notes.txt",
        expiresAt: "2026-09-02T12:01:00.000Z",
      },
    ],
  };

  it("marks a conversation waiting for approval on desktop", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        approvals={approvals}
        collapsed={false}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByText("Waiting for your approval")).toBeVisible();
    expect(screen.queryByText("Latest research")).not.toBeInTheDocument();
  });

  it("names the pending approval in the collapsed sidebar", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        approvals={approvals}
        collapsed
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByRole("button", { name: "Atlas, waiting for your approval" })).toBeVisible();
  });
});
