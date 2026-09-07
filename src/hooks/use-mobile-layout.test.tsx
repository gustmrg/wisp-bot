import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from "@/hooks/use-mobile-layout";

it("tracks keyboard viewport changes, leaves pinch zoom alone, and cleans up", () => {
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
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
