import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageView } from "@/components/message-view";
import { advanceReveal, NATURAL_RATE, ReplyPaceProvider, resetReplyPaceProgress } from "@/hooks/use-reply-pace";
import type { ReplyPace } from "@/lib/app-preferences";
import type { Message } from "../../shared/conversations";

describe("advanceReveal", () => {
  it("keeps the smooth pace with however much has arrived", () => {
    const text = "x".repeat(1_000);
    // A burst of 1000 characters shows within about a quarter of a second.
    expect(advanceReveal(text, 0, 0, 125, "smooth").shown).toBe(500);
    expect(advanceReveal(text, 0, 0, 260, "smooth").shown).toBe(1_000);
  });

  it("shows a natural reply a whole word at a time at a fixed pace", () => {
    const text = "one two three four five six seven eight nine ten ".repeat(20);
    const step = advanceReveal(text, 0, 0, 100, "natural");
    expect(step.shown).toBeGreaterThanOrEqual((NATURAL_RATE * 100) / 1000);
    expect(text[step.shown]).toBe(" ");
    // What a word end took beyond the budget is paid back before the next step.
    expect(advanceReveal(text, step.shown, step.carry, 20, "natural").shown).toBe(step.shown);
  });

  it("keeps the natural pace over many frames, however long the words", () => {
    const text = "extraordinarily ".repeat(200);
    let shown = 0;
    let carry = 0;
    for (let frame = 0; frame < 60; frame += 1) ({ shown, carry } = advanceReveal(text, shown, carry, 33, "natural"));
    // About two seconds: the pace, give or take the word being finished.
    expect(shown).toBeGreaterThan(NATURAL_RATE * 1.98 - 16);
    expect(shown).toBeLessThan(NATURAL_RATE * 1.98 + 16);
  });

  it("never splits an emoji", () => {
    const text = "a😀b";
    expect(advanceReveal(text, 0, 0, 1_000 / 90 / 0.5, "smooth").shown).not.toBe(2);
  });
});

describe("useRevealedText", () => {
  let now = 0;
  let frames: Array<FrameRequestCallback> = [];

  function runFrames(ms: number) {
    const end = now + ms;
    while (now < end) {
      now += 16;
      const due = frames;
      frames = [];
      act(() => {
        for (const frame of due) frame(now);
      });
    }
  }

  beforeEach(() => {
    resetReplyPaceProgress();
    now = 0;
    frames = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const reply = (text: string, status: Message["status"]): Message => ({ id: "r", type: "incoming", text, status });
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

  function view(pace: ReplyPace, message: Message) {
    return render(
      <ReplyPaceProvider pace={pace}>
        <MessageView message={message} />
      </ReplyPaceProvider>,
    );
  }

  it("shows a reply streaming in at the natural pace, then all of it", () => {
    const { rerender } = view("natural", reply("", "streaming"));
    rerender(
      <ReplyPaceProvider pace="natural">
        <MessageView message={reply(words, "complete")} />
      </ReplyPaceProvider>,
    );
    expect(screen.queryByText(words)).toBeNull();
    runFrames(500);
    const partial = document.querySelector(".message-bubble")?.textContent ?? "";
    expect(partial.length).toBeGreaterThan(10);
    expect(partial.length).toBeLessThan(words.length);
    runFrames(10_000);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("shows the rest at once when the reply is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const { rerender } = view("natural", reply("", "streaming"));
    rerender(
      <ReplyPaceProvider pace="natural">
        <MessageView message={reply(words, "streaming")} />
      </ReplyPaceProvider>,
    );
    runFrames(200);
    const revealing = document.querySelector<HTMLElement>("[data-revealing]");
    expect(revealing).not.toBeNull();
    await user.click(revealing as HTMLElement);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("shows history and the instant pace whole", () => {
    view("natural", reply(words, "complete"));
    expect(screen.getByText(words)).toBeTruthy();
    resetReplyPaceProgress();
    const { rerender } = view("instant", { ...reply("", "streaming"), id: "s" });
    rerender(
      <ReplyPaceProvider pace="instant">
        <MessageView message={{ ...reply(words, "streaming"), id: "s" }} />
      </ReplyPaceProvider>,
    );
    expect(screen.getAllByText(words)).toHaveLength(2);
  });

  it("shows everything a reply has once it fails", () => {
    const { rerender } = view("natural", reply("", "streaming"));
    rerender(
      <ReplyPaceProvider pace="natural">
        <MessageView message={reply(words, "failed")} />
      </ReplyPaceProvider>,
    );
    expect(screen.getByText(words)).toBeTruthy();
  });
});
