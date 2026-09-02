import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PREFERENCES_SAVE_DELAY_MS, PREFERENCES_STORAGE_KEY } from "@/features/persistence/storage-policy";
import { usePersistedPreferences } from "@/features/persistence/use-persisted-preferences";

describe("usePersistedPreferences", () => {
  afterEach(() => vi.useRealTimers());

  it("replaces a pending save when preferences change", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(usePersistedPreferences);

    act(() => {
      result.current.setPreferences((current) => ({ ...current, theme: "light" }));
      result.current.setPreferences((current) => ({ ...current, theme: "dark" }));
    });
    act(() => {
      vi.advanceTimersByTime(PREFERENCES_SAVE_DELAY_MS);
    });

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(PREFERENCES_STORAGE_KEY, expect.stringContaining('"theme":"dark"'));
    expect(result.current.status).toBe("saved");
  });

  it("flushes the latest snapshot before the debounce expires", () => {
    vi.useFakeTimers();
    const { result } = renderHook(usePersistedPreferences);
    act(() => result.current.setPreferences((current) => ({ ...current, theme: "dark" })));

    act(() => window.dispatchEvent(new Event("beforeunload")));

    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}")).toMatchObject({ theme: "dark" });
    expect(result.current.status).toBe("saved");
  });
});
