import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPLASH_FADE_MS, SplashOverlay, SplashScreen } from "@/components/splash-screen";
import { SLOW_OPENING_MS } from "@/lib/opening";

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("SplashScreen", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // The clock first counts from when the page opened; once no splash is
    // left on screen it starts over, so each test opens the app afresh.
    render(<SplashScreen />).unmount();
    await advance(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only the logo while opening is quick", async () => {
    render(<SplashScreen />);
    await advance(SLOW_OPENING_MS - 1);
    expect(screen.getByRole("status", { name: "Opening Wisp" })).toBeInTheDocument();
    expect(screen.queryByText("Taking longer than usual…")).not.toBeInTheDocument();
  });

  it("says so, with a way to reload, once opening takes five seconds", async () => {
    render(<SplashScreen />);
    await advance(SLOW_OPENING_MS);
    expect(screen.getByText("Taking longer than usual…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("keeps counting across the steps that show it in turn", async () => {
    const first = render(<SplashScreen />);
    await advance(SLOW_OPENING_MS - 1_000);
    // The next step replaces the splash in the same commit.
    first.rerender(<SplashScreen key="next" />);
    await advance(1_000);
    expect(screen.getByText("Taking longer than usual…")).toBeInTheDocument();
  });

  it("fades out over the app once it is ready", async () => {
    const { rerender } = render(<SplashOverlay ready={false} />);
    expect(screen.getByRole("status", { name: "Opening Wisp" })).toBeInTheDocument();
    rerender(<SplashOverlay ready />);
    expect(screen.getByRole("status", { name: "Opening Wisp" })).toHaveClass("opacity-0");
    await advance(SPLASH_FADE_MS);
    expect(screen.queryByRole("status", { name: "Opening Wisp" })).not.toBeInTheDocument();
  });
});
