import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Wisp } from "@/components/wisp";
import { hashSeed } from "@/lib/wisp-appearance";

const NAME = "Nova";
const FIRST_BLINK_MS = (2760 - (hashSeed(NAME) % 6000) + 6000) % 6000;

function setReducedMotion(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));
}

describe("useWispBlink", () => {
  const animate = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    animate.mockClear();
    setReducedMotion(false);
    (SVGElement.prototype as unknown as { animate: typeof animate }).animate = animate;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (SVGElement.prototype as unknown as { animate?: typeof animate }).animate;
  });

  it("blinks once per period at the place the name gives it", () => {
    render(<Wisp name={NAME} size="xl" />);

    vi.advanceTimersByTime(FIRST_BLINK_MS - 1);
    expect(animate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(animate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(12000);
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it("blinks in the conversation list", () => {
    render(
      <span className="conversation-avatar">
        <Wisp name={NAME} />
      </span>,
    );

    vi.advanceTimersByTime(6000);
    expect(animate).toHaveBeenCalled();
  });

  it("leaves a Wisp elsewhere still", () => {
    render(<Wisp name={NAME} />);

    vi.advanceTimersByTime(12000);
    expect(animate).not.toHaveBeenCalled();
  });

  it("does not blink when the person asks for reduced motion", () => {
    setReducedMotion(true);
    render(<Wisp name={NAME} size="xl" />);

    vi.advanceTimersByTime(12000);
    expect(animate).not.toHaveBeenCalled();
  });

  it("stops when the Wisp leaves the screen", () => {
    const { unmount } = render(<Wisp name={NAME} size="xl" />);

    unmount();
    vi.advanceTimersByTime(12000);
    expect(animate).not.toHaveBeenCalled();
  });
});
