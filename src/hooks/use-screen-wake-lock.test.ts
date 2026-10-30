import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useScreenWakeLock } from "@/hooks/use-screen-wake-lock";

function fakeSentinel() {
  const sentinel = {
    released: false,
    release: vi.fn(async () => {
      sentinel.released = true;
    }),
  };
  return sentinel;
}

function stubWakeLock(request: () => Promise<unknown>): void {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  Reflect.deleteProperty(document, "visibilityState");
});

describe("useScreenWakeLock", () => {
  it("holds the lock only while active", async () => {
    const sentinel = fakeSentinel();
    const request = vi.fn(async () => sentinel);
    stubWakeLock(request);

    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: false } });
    expect(request).not.toHaveBeenCalled();

    await act(async () => rerender({ active: true }));
    expect(request).toHaveBeenCalledWith("screen");
    expect(sentinel.release).not.toHaveBeenCalled();

    await act(async () => rerender({ active: false }));
    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it("asks again on return, after the system released the lock while the page was hidden", async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    stubWakeLock(request);

    const { unmount } = renderHook(() => useScreenWakeLock(true));
    await act(async () => undefined);
    expect(request).toHaveBeenCalledOnce();

    first.released = true;
    await act(async () => setVisibility("hidden"));
    expect(request).toHaveBeenCalledOnce();
    await act(async () => setVisibility("visible"));
    expect(request).toHaveBeenCalledTimes(2);

    // Coming back with the lock still held asks for nothing.
    await act(async () => setVisibility("visible"));
    expect(request).toHaveBeenCalledTimes(2);

    unmount();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("releases a lock granted after it stopped being needed", async () => {
    const sentinel = fakeSentinel();
    let grant = (_value: unknown): void => undefined;
    stubWakeLock(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );

    const { unmount } = renderHook(() => useScreenWakeLock(true));
    unmount();
    await act(async () => grant(sentinel));

    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it("goes on when the lock is refused or does not exist", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("refused", "NotAllowedError");
    });
    stubWakeLock(request);
    const refused = renderHook(() => useScreenWakeLock(true));
    await act(async () => undefined);
    expect(request).toHaveBeenCalledOnce();
    refused.unmount();

    Reflect.deleteProperty(navigator, "wakeLock");
    expect(() => renderHook(() => useScreenWakeLock(true)).unmount()).not.toThrow();
  });
});
