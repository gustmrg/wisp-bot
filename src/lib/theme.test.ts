import { afterEach, describe, expect, it } from "vitest";

import { applyTheme } from "@/lib/theme";

const originalMatchMedia = window.matchMedia;

/** A system theme the test can switch, shared by every `matchMedia` query. */
function systemTheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return dark;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  return {
    set(next: boolean) {
      dark = next;
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  applyTheme("light");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("applyTheme", () => {
  it("follows the system theme on system", () => {
    const system = systemTheme(true);
    applyTheme("system");
    expect(document.documentElement).toHaveClass("dark");
    system.set(false);
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("stops following the system theme once another preference applies", () => {
    const system = systemTheme(false);
    // Applied at startup, before the app takes over; nothing calls its cleanup.
    applyTheme("system");
    applyTheme("dark");
    system.set(false);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
