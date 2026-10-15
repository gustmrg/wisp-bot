import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SystemNotificationTarget } from "../../shared/contracts";
import { useSystemNotifications } from "@/hooks/use-system-notifications";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";

describe("useSystemNotifications", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "wisp");
  });

  it("configures the desktop app, reports the conversation on screen, and opens a clicked one", () => {
    let open: ((target: SystemNotificationTarget) => void) | undefined;
    const api = {
      configure: vi.fn(async () => ({ ok: true as const, value: {} })),
      setFocus: vi.fn(async () => ({ ok: true as const, value: {} })),
      test: vi.fn(),
      subscribeToOpen: vi.fn((listener: (target: SystemNotificationTarget) => void) => {
        open = listener;
        return () => undefined;
      }),
    };
    Object.defineProperty(window, "wisp", { configurable: true, value: { systemNotifications: api } });
    const onOpen = vi.fn();
    const { rerender } = renderHook((props) => useSystemNotifications(props), {
      initialProps: {
        preferences: { ...DEFAULT_PREFERENCES, systemNotifyOnError: false },
        shownChatId: "atlas" as string | null,
        onOpen,
      },
    });
    expect(api.configure).toHaveBeenCalledWith({
      enabled: true,
      onCompletion: true,
      onApproval: true,
      onError: false,
    });
    expect(api.setFocus).toHaveBeenLastCalledWith({ conversationId: "atlas" });
    rerender({ preferences: { ...DEFAULT_PREFERENCES, systemNotifyOnError: false }, shownChatId: null, onOpen });
    expect(api.setFocus).toHaveBeenLastCalledWith({ conversationId: null });
    expect(api.configure).toHaveBeenCalledTimes(1);
    open?.({ conversationId: "nova", approvalId: "a1" });
    expect(onOpen).toHaveBeenCalledWith({ conversationId: "nova", approvalId: "a1" });
  });

  it("does nothing in the browser app", () => {
    Object.defineProperty(window, "wisp", { configurable: true, value: {} });
    expect(() =>
      renderHook(() =>
        useSystemNotifications({ preferences: DEFAULT_PREFERENCES, shownChatId: null, onOpen: vi.fn() }),
      ),
    ).not.toThrow();
  });
});
