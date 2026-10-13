import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { soulText, WispProfile } from "@/components/wisp-profile";
import { wispChatView } from "@/test/chat-fixtures";

const atlas = wispChatView("atlas", {
  wisp: {
    name: "Atlas",
    role: "Research",
    soul: "# Atlas\n\nCurious, **careful** with sources.\n\nShort answers first.",
  },
});

beforeEach(() => {
  vi.stubGlobal("wisp", {
    getConversationModel: vi.fn(async () => ({
      ok: true,
      value: { effective: { providerId: "openrouter", modelId: "claude-sonnet-5-5" } },
    })),
    getJobs: vi.fn(async () => ({
      ok: true,
      value: {
        jobs: [
          {
            id: "digest",
            conversationId: "atlas",
            title: "Morning digest",
            schedule: { kind: "daily", time: "08:00" },
            timeZone: "UTC",
            paused: { reason: "person", at: "2026-10-01T00:00:00Z" },
          },
          { id: "other", conversationId: "forge", title: "Not Atlas's", schedule: { kind: "daily", time: "09:00" } },
        ],
      },
    })),
    subscribeToJobs: vi.fn(() => () => {}),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soulText", () => {
  it("keeps the soul's paragraphs without headings or Markdown marks", () => {
    expect(soulText(atlas.wisp.soul)).toBe("Curious, careful with sources.\n\nShort answers first.");
  });
});

function renderProfile(overrides: Partial<Parameters<typeof WispProfile>[0]> = {}) {
  const props = {
    chat: atlas,
    state: "idle" as const,
    onBack: vi.fn(),
    onOpenSection: vi.fn(),
    onChangeNotifications: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<WispProfile {...props} />);
  return props;
}

describe("WispProfile", () => {
  it("shows who the Wisp is and what it knows and does, with its jobs counted", async () => {
    renderProfile();
    const profile = screen.getByRole("region", { name: "Atlas" });
    expect(within(profile).getByText("Research")).toBeVisible();
    expect(within(profile).getByRole("region", { name: "Soul" })).toHaveTextContent("Curious, careful with sources.");
    const more = within(profile).getByRole("region", { name: "What Atlas knows and does" });
    expect(await within(more).findByText("1 scheduled")).toBeVisible();
    expect(within(more).getByRole("button", { name: /Memory/ })).toBeVisible();
  });

  it("goes back to the chat, or into a page of its settings", async () => {
    const user = userEvent.setup();
    const props = renderProfile();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(props.onBack).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(props.onOpenSection).toHaveBeenLastCalledWith("profile");
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(props.onOpenSection).toHaveBeenLastCalledWith("model");
    await user.click(screen.getByRole("button", { name: /Commands/ }));
    expect(props.onOpenSection).toHaveBeenLastCalledWith("execution");
  });

  it("turns notifications off from the profile, and deletes only after confirmation", async () => {
    const user = userEvent.setup();
    const props = renderProfile();
    await user.click(screen.getByRole("switch", { name: "Notifications" }));
    expect(props.onChangeNotifications).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Delete Atlas…" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(props.onDelete).toHaveBeenCalledOnce();
  });
});
