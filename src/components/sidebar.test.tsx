import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      getWispSetup: vi.fn(async () => ({
        ok: true,
        value: { maxQuotaBytes: 1024, runtime: { available: false, message: "none" } },
      })),
    },
  });
});

describe("Sidebar current user", () => {
  it("renders injected identity metadata", () => {
    render(<Sidebar activeChatId="" chats={{}} currentUser={currentUser} width={280} {...callbacks} />);

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("AL")).toBeVisible();
  });

  it("shows a user icon instead of initials when no name is set", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={{}}
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
    render(<Sidebar activeChatId="" chats={{}} currentUser={currentUser} width={280} {...callbacks} />);

    await user.click(screen.getByRole("button", { name: "Create Wisp" }));

    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("opens on a new Wisp and offers a circle of the existing Wisps in a tab", async () => {
    const user = userEvent.setup();
    const onCreateCircle = vi.fn(async () => true);
    const chats: ChatViewCollection = { atlas: wispChatView("atlas", { wisp: { name: "Atlas" } }) };
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        currentUser={currentUser}
        width={280}
        {...callbacks}
        onCreateCircle={onCreateCircle}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Circle" }));
    expect(screen.getByRole("heading", { name: "Create new circle" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(screen.getByRole("checkbox", { name: "Atlas" }));
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(onCreateCircle).toHaveBeenCalledWith(expect.objectContaining({ name: "Crew", memberIds: ["atlas"] }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Create new circle" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Circle" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
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
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByText("Waiting for your approval")).toBeVisible();
    expect(screen.queryByText("Latest research")).not.toBeInTheDocument();
  });

  it("leaves approvals to the conversation on desktop instead of listing them", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        approvals={approvals}
        currentUser={currentUser}
        width={280}
        onResolveApproval={vi.fn()}
        {...callbacks}
      />,
    );
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for your approval")).toBeVisible();
  });

  it("rings a Wisp waiting for approval, and its eyes grow", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        approvals={approvals}
        failedChats={{ atlas: true }}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    // Approval needs the person, so it wins over a failure.
    expect(container.querySelector(".conversation-avatar")).toHaveAttribute("data-state", "approval");
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
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(screen.getByText("The last reply failed")).toBeVisible();
    expect(container.querySelector(".conversation-avatar")).toHaveAttribute("data-state", "error");
    expect(container.querySelector("[data-slot=wisp]")).toHaveAttribute("data-state", "error");
  });

  it("animates a Wisp while it works and says what it is doing", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        statuses={{ atlas: "working" }}
        activity={{ atlas: "Searching the web…" }}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(container.querySelector("[data-slot=wisp]")).toHaveAttribute("data-state", "working");
    expect(screen.getByText("Searching the web…")).toBeVisible();
    expect(screen.queryByText("Latest research")).not.toBeInTheDocument();
  });
});

describe("Sidebar rail", () => {
  const chats: ChatViewCollection = {
    atlas: wispChatView("atlas", { wisp: { name: "Atlas" }, chat: { preview: "Latest research", unread: true } }),
  };

  it("collapses from the button left of the search", async () => {
    const user = userEvent.setup();
    const onToggleCollapsed = vi.fn();
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        currentUser={currentUser}
        width={280}
        onToggleCollapsed={onToggleCollapsed}
        {...callbacks}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.nextElementSibling).toHaveTextContent("Search");
    await user.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("folds to avatars that still name each Wisp and its state", () => {
    const { container } = render(
      <Sidebar
        activeChatId=""
        chats={chats}
        statuses={{ atlas: "working" }}
        currentUser={currentUser}
        width={280}
        collapsed
        onToggleCollapsed={vi.fn()}
        {...callbacks}
      />,
    );

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Atlas, working, unread" })).toBeVisible();
    expect(screen.queryByText("Latest research")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create Wisp" })).toBeVisible();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
    expect(container.querySelector("[role=separator]")).not.toBeInTheDocument();
  });

  it("keeps the full list on mobile", () => {
    render(
      <Sidebar
        activeChatId=""
        chats={chats}
        currentUser={currentUser}
        width={280}
        mobile
        collapsed
        onToggleCollapsed={vi.fn()}
        {...callbacks}
      />,
    );

    expect(screen.queryByRole("button", { name: /(Expand|Collapse) sidebar/ })).not.toBeInTheDocument();
    expect(screen.getByText("Latest research")).toBeVisible();
  });

  it("marks the open conversation only beside it, on the desktop", () => {
    const { rerender } = render(
      <Sidebar activeChatId="atlas" chats={chats} currentUser={currentUser} width={280} {...callbacks} />,
    );
    const list = () => screen.getByRole("navigation", { name: "Wisps and circles" });
    expect(within(list()).getByRole("button", { name: /Atlas/ })).toHaveAttribute("aria-current", "page");

    rerender(
      <Sidebar mobile activeChatId="atlas" chats={chats} currentUser={currentUser} width={280} {...callbacks} />,
    );
    const atlas = within(list()).getByRole("button", { name: /Atlas/ });
    expect(atlas).not.toHaveAttribute("aria-current");
    expect(atlas).toHaveAttribute("data-selected", "false");
  });
});

describe("Sidebar previews", () => {
  it("previews a message with attachments by its files, without the list the Wisp reads", () => {
    const chats: ChatViewCollection = {
      atlas: wispChatView("atlas", {
        wisp: { name: "Atlas" },
        chat: { preview: "Attached to the workspace:\n- `inbox/boleto.pdf`" },
      }),
    };
    render(<Sidebar activeChatId="" chats={chats} currentUser={currentUser} width={280} {...callbacks} />);
    expect(screen.getByText("boleto.pdf")).toBeVisible();
    expect(screen.queryByText(/Attached to the workspace/)).toBeNull();
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
    render(<Sidebar mobile activeChatId="" chats={chats} currentUser={currentUser} width={280} {...callbacks} />);
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

  it("counts the unread messages in the badge, up to 99+", () => {
    const counted = (unreadCount: number) =>
      wispChatView("beta", { wisp: { name: "Beta" }, chat: { preview: "Fresh reply", unread: true, unreadCount } });
    const { rerender } = render(
      <Sidebar
        mobile
        activeChatId=""
        chats={{ beta: counted(3) }}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    const list = () => screen.getByRole("navigation", { name: "Wisps and circles" });
    const beta = within(list()).getByRole("button", { name: /Beta/ });
    expect(within(beta).getByText("3")).toHaveAttribute("aria-hidden", "true");
    expect(within(beta).getByText("3 unread")).toHaveClass("sr-only");

    rerender(
      <Sidebar
        mobile
        activeChatId=""
        chats={{ beta: counted(120) }}
        currentUser={currentUser}
        width={280}
        {...callbacks}
      />,
    );
    expect(within(beta).getByText("99+")).toBeVisible();
    expect(within(beta).getByText("120 unread")).toHaveClass("sr-only");
  });
});

describe("Sidebar conversation menu", () => {
  const chats: ChatViewCollection = {
    atlas: wispChatView("atlas", {
      wisp: { name: "Atlas" },
      chat: { preview: "Older note", lastActivityAt: "2026-10-01T10:00:00.000Z", notifyOnUpdatesEnabled: true },
    }),
    beta: wispChatView("beta", {
      wisp: { name: "Beta" },
      chat: { preview: "Fresh reply", unread: true, lastActivityAt: "2026-10-09T10:00:00.000Z" },
    }),
    gamma: wispChatView("gamma", {
      wisp: { name: "Gamma" },
      chat: {
        preview: "Pinned note",
        pinned: true,
        notifyOnUpdatesEnabled: false,
        lastActivityAt: "2026-09-01T10:00:00.000Z",
      },
    }),
  };

  beforeEach(() => callbacks.onSelectChat.mockClear());

  function renderList(onChatAction = vi.fn(), mobile = true) {
    render(
      <Sidebar
        mobile={mobile}
        activeChatId=""
        chats={chats}
        currentUser={currentUser}
        width={280}
        {...callbacks}
        onChatAction={onChatAction}
      />,
    );
    return within(screen.getByRole("navigation", { name: "Wisps and circles" }));
  }

  const names = (list: ReturnType<typeof renderList>) =>
    list.getAllByRole("button").map((item) => item.querySelector("strong")?.textContent);

  it("puts pinned conversations first, on mobile and on the desktop", () => {
    const mobile = renderList();
    expect(names(mobile)).toEqual(["Gamma", "Beta", "Atlas"]);
    expect(within(mobile.getByRole("button", { name: /Gamma/ })).getByText("Pinned")).toHaveClass("sr-only");
    document.body.innerHTML = "";

    expect(names(renderList(vi.fn(), false))).toEqual(["Gamma", "Beta", "Atlas"]);
  });

  it("offers each action for what the conversation is now", async () => {
    const user = userEvent.setup();
    const onChatAction = vi.fn();
    const list = renderList(onChatAction);

    fireEvent.contextMenu(list.getByRole("button", { name: /Atlas/ }));
    const atlasMenu = await screen.findByRole("menu");
    expect(
      within(atlasMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Pin", "Mute notifications", "Mark as unread"]);
    await user.click(within(atlasMenu).getByRole("menuitem", { name: "Mark as unread" }));
    expect(onChatAction).toHaveBeenCalledWith("atlas", "unread");
    await waitForMenuToClose();

    fireEvent.contextMenu(list.getByRole("button", { name: /Gamma/ }));
    expect(
      within(await screen.findByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Unpin", "Turn on notifications", "Mark as unread"]);
    await user.keyboard("{Escape}");
    await waitForMenuToClose();

    fireEvent.contextMenu(list.getByRole("button", { name: /Beta/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark as read" }));
    expect(onChatAction).toHaveBeenCalledWith("beta", "read");
    expect(callbacks.onSelectChat).not.toHaveBeenCalled();
  });

  it("works from the keyboard and returns focus to the conversation", async () => {
    const user = userEvent.setup();
    const onChatAction = vi.fn();
    const list = renderList(onChatAction);
    const gamma = list.getByRole("button", { name: /Gamma/ });
    gamma.focus();

    // Browsers fire contextmenu on the focused element for the menu key and Shift+F10.
    fireEvent.contextMenu(gamma);
    const menu = await screen.findByRole("menu");
    // Keys pressed before the menu takes focus would go to the conversation instead.
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Turn on notifications" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onChatAction).toHaveBeenCalledWith("gamma", "unmute");
    await waitForMenuToClose();
    expect(gamma).toHaveFocus();
  });

  it("opens the menu on a long press without opening the conversation", async () => {
    vi.useFakeTimers();
    try {
      const list = renderList();
      const beta = list.getByRole("button", { name: /Beta/ });

      fireEvent.touchStart(beta, { touches: [{ clientX: 20, clientY: 20 }] });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.touchEnd(beta);
      fireEvent.click(beta);

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(callbacks.onSelectChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function waitForMenuToClose() {
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
}
