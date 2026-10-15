import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { MessageStatus } from "../../shared/conversations";
import type { ReplyPace } from "@/lib/app-preferences";

/** Smooth never shows less than this many characters a second... */
const SMOOTH_MIN_RATE = 90;
/** ...and catches up with what has arrived within about this long, so it never falls behind the model. */
const SMOOTH_CATCH_UP_SECONDS = 0.25;
/** Natural keeps to this pace however fast the model is, and after it is done. */
export const NATURAL_RATE = 45;
/** A frame shows at most this often, so a long reply's Markdown is not parsed every frame. */
const FRAME_INTERVAL_MS = 33;

const ReplyPaceContext = createContext<ReplyPace>("instant");

/** Paces every Wisp reply below it. */
export function ReplyPaceProvider({ pace, children }: { pace: ReplyPace; children: ReactNode }) {
  return <ReplyPaceContext.Provider value={pace}>{children}</ReplyPaceContext.Provider>;
}

/**
 * How much of each reply is shown, by message ID, so one that remounts while
 * it is still appearing (a conversation switched away and back) carries on
 * where it was instead of starting over.
 */
const shownLengths = new Map<string, number>();

/** For tests: forget every reply's progress. */
export function resetReplyPaceProgress(): void {
  shownLengths.clear();
}

/**
 * Where a reply showing `shown` characters of `text` is after `elapsedMs`,
 * with `carry` the fraction of a character left over from the last step.
 */
export function advanceReveal(
  text: string,
  shown: number,
  carry: number,
  elapsedMs: number,
  pace: Exclude<ReplyPace, "instant">,
): { shown: number; carry: number } {
  const backlog = text.length - shown;
  if (backlog <= 0) return { shown: text.length, carry: 0 };
  const rate = pace === "natural" ? NATURAL_RATE : Math.max(SMOOTH_MIN_RATE, backlog / SMOOTH_CATCH_UP_SECONDS);
  const budget = carry + (rate * elapsedMs) / 1000;
  const whole = Math.floor(budget);
  if (whole <= 0) return { shown, carry: budget };
  let next = Math.min(text.length, shown + whole);
  // Natural shows whole words; the time spent past the word end is paid back by waiting.
  if (pace === "natural" && next < text.length) {
    const space = text.slice(next).search(/\s/u);
    next = space === -1 ? text.length : next + space;
  }
  // Never split a character made of two code units, such as an emoji.
  const unit = text.charCodeAt(next - 1);
  if (next < text.length && unit >= 0xd800 && unit <= 0xdbff) next += 1;
  // A word end shown ahead of its time leaves the carry negative, so the next word waits for it.
  return { shown: next, carry: budget - (next - shown) };
}

/**
 * The part of a Wisp's reply to show now. A reply that streams in while the
 * conversation is open appears at the person's chosen pace; one already
 * written when it first shows, such as history, appears whole. A reply that
 * failed or was stopped shows everything it has at once.
 */
export function useRevealedText(
  id: string | undefined,
  text: string,
  status: MessageStatus | undefined,
): { text: string; revealing: boolean; finish: () => void } {
  const pace = useContext(ReplyPaceContext);
  const streaming = status === "streaming";
  const paced = pace !== "instant" && status !== "failed" && status !== "cancelled";
  const [shown, setShown] = useState(() => {
    const saved = id === undefined ? undefined : shownLengths.get(id);
    if (saved !== undefined) return saved;
    // A reply first seen streaming appears from the start; the first chunk is a moment's worth.
    return streaming && paced ? 0 : text.length;
  });
  const carry = useRef(0);
  const visible = paced ? Math.min(shown, text.length) : text.length;
  const revealing = visible < text.length;

  useEffect(() => {
    if (id === undefined) return;
    if (revealing || streaming) shownLengths.set(id, visible);
    else shownLengths.delete(id);
  }, [id, visible, revealing, streaming]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `visible` only seeds a loop that (re)starts on more text, another pace, or a reveal starting.
  useEffect(() => {
    if (!revealing || pace === "instant") return;
    let frame = 0;
    let last = performance.now();
    let current = visible;
    const tick = (now: number) => {
      const elapsed = now - last;
      if (elapsed >= FRAME_INTERVAL_MS) {
        const step = advanceReveal(text, current, carry.current, elapsed, pace);
        last = now;
        carry.current = step.carry;
        if (step.shown !== current) {
          current = step.shown;
          setShown(current);
        }
      }
      if (current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, pace, revealing]);

  return {
    text: revealing ? text.slice(0, visible) : text,
    revealing,
    // Skipping shows the rest of this reply, and whatever still arrives, at once.
    finish: () => setShown(Number.POSITIVE_INFINITY),
  };
}
