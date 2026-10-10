import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useTransientMessage } from "@/hooks/use-transient-message";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("clears a message after its duration, restarting when a new one arrives", () => {
  const { result } = renderHook(() => useTransientMessage(1000));
  act(() => result.current[1]("Saved."));
  expect(result.current[0]).toBe("Saved.");

  act(() => vi.advanceTimersByTime(800));
  act(() => result.current[1]("Saved again."));
  act(() => vi.advanceTimersByTime(800));
  expect(result.current[0]).toBe("Saved again.");

  act(() => vi.advanceTimersByTime(200));
  expect(result.current[0]).toBe("");
});
