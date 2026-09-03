import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/config/app-metadata";
import { Sidebar } from "@/components/sidebar";

const currentUser: CurrentUser = {
  displayName: "Ada Lovelace",
  email: "ada@example.test",
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

describe("Sidebar current user", () => {
  it("renders injected identity metadata", () => {
    render(
      <Sidebar activeChatId="" chats={{}} collapsed={false} currentUser={currentUser} width={280} {...callbacks} />,
    );

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("AL")).toBeVisible();
  });

  it("opens a Wisp-only creation dialog without a kind selector", async () => {
    const user = userEvent.setup();
    render(
      <Sidebar activeChatId="" chats={{}} collapsed={false} currentUser={currentUser} width={280} {...callbacks} />,
    );

    const createButton = screen.getByRole("button", { name: "Create Wisp" });
    expect(createButton).toHaveClass("w-fit", "text-sm");
    expect(createButton).not.toHaveClass("w-full");

    await user.click(createButton);

    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Creation type" })).not.toBeInTheDocument();
  });
});
