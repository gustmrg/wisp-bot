import { describe, expect, it } from "vitest";

import {
  formatShortcut,
  isValidShortcut,
  matchesShortcut,
  normalizeShortcuts,
  reservedShortcutLabel,
  shortcutFromEvent,
} from "@/lib/shortcuts";

function key(code: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

describe("shortcuts", () => {
  it("matches only the exact modifier combination", () => {
    expect(matchesShortcut(key("Space", { ctrlKey: true }), "Ctrl+Space")).toBe(true);
    expect(matchesShortcut(key("Space", { ctrlKey: true, shiftKey: true }), "Ctrl+Space")).toBe(false);
    expect(matchesShortcut(key("Space"), "Ctrl+Space")).toBe(false);
    expect(matchesShortcut(key("KeyM", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+KeyM")).toBe(true);
  });

  it("records a key press, waiting while only modifiers are held", () => {
    expect(shortcutFromEvent(key("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(key("KeyM", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+KeyM");
    expect(shortcutFromEvent(key("F8"))).toBe("F8");
  });

  it("rejects combinations that would swallow ordinary typing", () => {
    expect(shortcutFromEvent(key("KeyM"))).toBeNull();
    expect(shortcutFromEvent(key("KeyM", { shiftKey: true }))).toBeNull();
    expect(isValidShortcut("Ctrl+Ctrl+Space")).toBe(false);
    expect(isValidShortcut("Hyper+Space")).toBe(false);
    expect(normalizeShortcuts({ voiceInput: "Space" })).toEqual({ voiceInput: "Ctrl+Space" });
  });

  it("knows which shortcuts the app already uses", () => {
    expect(reservedShortcutLabel("Ctrl+KeyK")).toBe("Search");
    expect(reservedShortcutLabel("Ctrl+Space")).toBeUndefined();
  });

  it("labels keys the way each platform's keyboards do", () => {
    expect(formatShortcut("Ctrl+Shift+KeyM", false)).toBe("Ctrl+Shift+M");
    expect(formatShortcut("Ctrl+Space", true)).toBe("⌃Space");
    expect(formatShortcut("Meta+Alt+Digit1", true)).toBe("⌥⌘1");
  });
});
