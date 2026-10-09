import { useEffect, useSyncExternalStore } from "react";

// Keep this query aligned with the responsive rules in mobile.css.
export const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useMobileLayout(): boolean {
  const mobile = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
    () => false,
  );

  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    function updateHeight() {
      // Leave pinch zoom to the browser; only track the keyboard/browser chrome.
      if (viewport && viewport.scale !== 1) return;
      document.documentElement.style.setProperty(
        "--mobile-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      // iOS ignores interactive-widget and scrolls the page to show a focused field
      // above the keyboard, which would push the header off screen. The shell
      // already fits the visible area, so the page goes back to the top.
      if (viewport && viewport.offsetTop > 0) window.scrollTo(0, 0);
    }
    updateHeight();
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    window.addEventListener("resize", updateHeight);
    return () => {
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
      document.documentElement.style.removeProperty("--mobile-viewport-height");
    };
  }, [mobile]);

  return mobile;
}
