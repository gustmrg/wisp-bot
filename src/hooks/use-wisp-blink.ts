import { useEffect, type RefObject } from "react";

import { hashSeed } from "@/lib/wisp-appearance";

const BLINK_PERIOD_MS = 6000;
/** Where in its period a Wisp blinks, so a name keeps the same place in the rhythm. */
const BLINK_START_MS = 2760;
const BLINK_DURATION_MS = 240;

/** Only the large picture and the conversation list blink; elsewhere the eyes are too small to read. */
const BLINKING_WISP = '[data-slot="wisp"][data-size="xl"], .conversation-avatar [data-slot="wisp"]';

/** `transform`, not `scale`: Chromium runs it on SVG elements off the main thread. */
const BLINK_KEYFRAMES: Keyframe[] = [
  { transform: "scaleY(1)", easing: "ease" },
  { transform: "scaleY(0.1)", easing: "ease" },
  { transform: "scaleY(1)" },
];

/**
 * Blinks a Wisp's eyes every few seconds. An endless CSS animation made Chromium
 * recalculate styles and layout on every frame even between blinks, so the idle
 * app never stopped working. A timer starts a short animation only when one is due.
 */
export function useWispBlink(eyesRef: RefObject<SVGGElement | null>, seed: string) {
  useEffect(() => {
    const eyes = eyesRef.current;
    if (!eyes?.closest(BLINKING_WISP) || typeof eyes.animate !== "function") return;

    function blink() {
      // CSS reduced-motion rules do not reach animations started from script.
      if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      eyes?.animate(BLINK_KEYFRAMES, BLINK_DURATION_MS);
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    const firstDelay = (BLINK_START_MS - (hashSeed(seed) % BLINK_PERIOD_MS) + BLINK_PERIOD_MS) % BLINK_PERIOD_MS;
    const first = setTimeout(() => {
      blink();
      interval = setInterval(blink, BLINK_PERIOD_MS);
    }, firstDelay);

    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [eyesRef, seed]);
}
