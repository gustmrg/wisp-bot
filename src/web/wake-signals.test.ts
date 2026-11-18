import { describe, expect, it, vi } from "vitest";

import { watchBrowserWake } from "@/web/wake-signals";

function showPage(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("watchBrowserWake", () => {
  it("wakes when the page comes back or the network returns, never when it goes away", () => {
    const onWake = vi.fn();
    watchBrowserWake(onWake);

    showPage("hidden");
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    expect(onWake).not.toHaveBeenCalled();

    showPage("visible");
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new Event("online"));
    expect(onWake).toHaveBeenCalledTimes(4);
  });
});
