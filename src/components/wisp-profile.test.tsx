import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WispProfile, soulText } from "@/components/wisp-profile";
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

describe("WispProfile", () => {
  it("shows who the Wisp is, its model and its jobs", async () => {
    render(<WispProfile chat={atlas} state="idle" onBack={vi.fn()} onOpenSettings={vi.fn()} />);
    const profile = screen.getByRole("region", { name: "Atlas" });
    expect(within(profile).getByText("Research")).toBeVisible();
    expect(within(profile).getByRole("region", { name: "Soul" })).toHaveTextContent("Curious, careful with sources.");
    expect(await within(profile).findByText("claude-sonnet-5-5")).toBeVisible();
    const jobs = within(profile).getByRole("region", { name: "Jobs" });
    expect(await within(jobs).findByText("Morning digest")).toBeVisible();
    expect(within(jobs).getByText("Paused")).toBeVisible();
    expect(within(jobs).queryByText("Not Atlas's")).not.toBeInTheDocument();
  });

  it("goes back to the chat, or into a settings tab", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onOpenSettings = vi.fn();
    render(<WispProfile chat={atlas} state="idle" onBack={onBack} onOpenSettings={onOpenSettings} />);
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(onBack).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith("general");
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith("model");
    await user.click(screen.getByRole("button", { name: "Usage" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith("usage");
  });
});
