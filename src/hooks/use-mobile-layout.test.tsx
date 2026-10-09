import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from "@/hooks/use-mobile-layout";

it("tracks keyboard viewport changes, leaves pinch zoom alone, and cleans up", () => {
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1, offsetTop: 0 });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("visualViewport", viewport);
  try {
    const { unmount } = renderHook(useMobileLayout);
    const height = () => document.documentElement.style.getPropertyValue("--mobile-viewport-height");
    expect(height()).toBe("844px");
    act(() => {
      viewport.height = 420;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(height()).toBe("420px");
    expect(scrollTo).not.toHaveBeenCalled();
    // iOS scrolls the page to show the focused composer; it goes back so the header stays visible.
    act(() => {
      viewport.offsetTop = 300;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    viewport.offsetTop = 0;
    act(() => {
      viewport.scale = 2;
      viewport.height = 210;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(height()).toBe("420px");
    unmount();
    expect(height()).toBe("");
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});
