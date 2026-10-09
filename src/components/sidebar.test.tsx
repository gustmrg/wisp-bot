import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatViewCollection } from "@/chat-data";
import type { CurrentUser } from "@/config/app-metadata";
import { Sidebar } from "@/components/sidebar";
import { wispChatView } from "@/test/chat-fixtures";

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
  const chats: ChatViewCollection = {
    atlas: wispChatView("atlas", { wisp: { name: "Atlas" }, chat: { preview: "Latest research" } }),
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

  it("marks waiting for approval with a dot instead of the shield, and the Wisp's eyes grow", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        approvals={approvals}
        failedChats={{ atlas: true }}
        collapsed={false}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(container.querySelector(".approval-indicator")).not.toBeNull();
    // Approval needs the person, so it wins over a failure.
    expect(container.querySelector(".error-indicator")).toBeNull();
    expect(container.querySelector("[data-slot=wisp]")).toHaveAttribute("data-state", "approval");
  });
});

describe("Sidebar states", () => {
  const chats: ChatViewCollection = {
    atlas: wispChatView("atlas", { wisp: { name: "Atlas" }, chat: { preview: "Latest research" } }),
  };

  it("marks a conversation whose last reply failed", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        failedChats={{ atlas: true }}
        collapsed={false}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByText("The last reply failed")).toBeVisible();
    expect(container.querySelector(".error-indicator")).not.toBeNull();
    expect(container.querySelector("[data-slot=wisp]")).toHaveAttribute("data-state", "error");
  });

  it("names a failed reply in the collapsed sidebar", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        failedChats={{ atlas: true }}
        collapsed
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByRole("button", { name: "Atlas, the last reply failed" })).toBeVisible();
  });

  it("animates a Wisp while it works", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        statuses={{ atlas: "working" }}
        collapsed={false}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(container.querySelector("[data-slot=wisp]")).toHaveAttribute("data-state", "working");
    expect(screen.getByText("Latest research")).toBeVisible();
  });
});

describe("Sidebar on mobile", () => {
  const chats: ChatViewCollection = {
    atlas: wispChatView("atlas", {
      wisp: { name: "Atlas" },
      chat: { preview: "Older note", lastActivityAt: "2026-10-01T10:00:00.000Z" },
    }),
    beta: wispChatView("beta", {
      wisp: { name: "Beta" },
      chat: { preview: "Fresh reply", unread: true, lastActivityAt: "2026-10-09T10:00:00.000Z" },
    }),
    gamma: wispChatView("gamma", { wisp: { name: "Gamma" }, chat: { preview: "Nothing yet" } }),
  };

  it("lists the latest activity first, with an unread badge beside the preview", async () => {
    const user = userEvent.setup();
    render(
      <Sidebar
        mobile
        activeChatId=""
        chats={chats}
        collapsed={false}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    const list = screen.getByRole("navigation", { name: "Wisps and circles" });

    expect(
      within(list)
        .getAllByRole("button")
        .map((item) => item.querySelector("strong")?.textContent),
    ).toEqual(["Beta", "Atlas", "Gamma"]);
    const beta = within(list).getByRole("button", { name: /Beta/ });
    expect(beta).toHaveAttribute("data-unread", "true");
    expect(within(beta).getByText("Unread")).toHaveClass("sr-only");
    expect(within(list).getByRole("button", { name: /Atlas/ })).not.toHaveAttribute("data-unread");
    expect(screen.queryByLabelText("Unread activity")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unread 1" }));
    expect(within(list).getAllByRole("button")).toHaveLength(1);
  });
});
