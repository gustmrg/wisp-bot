import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCopyFeedback } from "@/hooks/use-copy-feedback";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe("useCopyFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setClipboard(undefined);
  });

  it("reports unavailable clipboard access as an error", async () => {
    setClipboard(undefined);
    const { result } = renderHook(() => useCopyFeedback("atlas"));

    await act(async () => {
      await expect(result.current.copy("wisp://template/atlas")).resolves.toBe(false);
    });

    expect(result.current).toMatchObject({
      status: "error",
      message: "Clipboard access is unavailable",
    });
  });

  it("announces success only after the clipboard promise resolves and then resets", async () => {
    const write = deferred();
    setClipboard(() => write.promise);
    const { result } = renderHook(() => useCopyFeedback("atlas", 1_400));
    let copyPromise!: Promise<boolean>;

    act(() => {
      copyPromise = result.current.copy("wisp://template/atlas");
    });
    expect(result.current.status).toBe("copying");

    await act(async () => {
      write.resolve();
      await expect(copyPromise).resolves.toBe(true);
    });
    expect(result.current.status).toBe("success");

    act(() => vi.advanceTimersByTime(1_400));
    expect(result.current.status).toBe("idle");
  });

  it("reports a rejected clipboard request as an error", async () => {
    setClipboard(() => Promise.reject(new Error("denied")));
    const { result } = renderHook(() => useCopyFeedback("atlas"));

    await act(async () => {
      await expect(result.current.copy("wisp://template/atlas")).resolves.toBe(false);
    });

    expect(result.current).toMatchObject({
      status: "error",
      message: "Could not copy template link",
    });
  });

  it("invalidates an earlier request when copy is clicked repeatedly", async () => {
    const first = deferred();
    const second = deferred();
    const writeText = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    setClipboard(writeText);
    const { result } = renderHook(() => useCopyFeedback("atlas"));
    let firstCopy!: Promise<boolean>;
    let secondCopy!: Promise<boolean>;

    act(() => {
      firstCopy = result.current.copy("first");
      secondCopy = result.current.copy("second");
    });

    await act(async () => {
      first.resolve();
      await expect(firstCopy).resolves.toBe(false);
    });
    expect(result.current.status).toBe("copying");

    await act(async () => {
      second.resolve();
      await expect(secondCopy).resolves.toBe(true);
    });
    expect(result.current.status).toBe("success");
    expect(writeText).toHaveBeenNthCalledWith(1, "first");
    expect(writeText).toHaveBeenNthCalledWith(2, "second");
  });

  it("does not leak status across chat changes", async () => {
    setClipboard(async () => undefined);
    const { result, rerender } = renderHook(({ chatId }) => useCopyFeedback(chatId), {
      initialProps: { chatId: "atlas" },
    });

    await act(async () => {
      await result.current.copy("wisp://template/atlas");
    });
    expect(result.current.status).toBe("success");

    rerender({ chatId: "pixel" });
    expect(result.current.status).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up pending work on unmount", async () => {
    const write = deferred();
    setClipboard(() => write.promise);
    const { result, unmount } = renderHook(() => useCopyFeedback("atlas"));
    let copyPromise!: Promise<boolean>;

    act(() => {
      copyPromise = result.current.copy("wisp://template/atlas");
    });
    unmount();

    write.resolve();
    await expect(copyPromise).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
