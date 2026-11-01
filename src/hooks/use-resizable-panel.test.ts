import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { useResizablePanel } from "@/hooks/use-resizable-panel";

const POINTER_ID = 7;

function pointerEvent(type: string, clientX = 0) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: POINTER_ID },
  });
  return event;
}

function resizeHandle() {
  const panel = document.createElement("aside");
  const handle = panel.appendChild(document.createElement("div"));
  let captured = false;
  const setPointerCapture = vi.fn(() => {
    captured = true;
  });
  const hasPointerCapture = vi.fn(() => captured);
  const releasePointerCapture = vi.fn(() => {
    captured = false;
  });

  Object.defineProperties(handle, {
    hasPointerCapture: { value: hasPointerCapture },
    releasePointerCapture: { value: releasePointerCapture },
    setPointerCapture: { value: setPointerCapture },
  });

  return { handle, panel, hasPointerCapture, releasePointerCapture, setPointerCapture };
}

function startResize(
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void,
  handle: HTMLElement,
  clientX = 100,
) {
  const preventDefault = vi.fn();
  act(() => {
    onResizeStart({
      clientX,
      currentTarget: handle,
      pointerId: POINTER_ID,
      preventDefault,
    } as unknown as ReactPointerEvent<HTMLElement>);
  });
  return preventDefault;
}

describe("useResizablePanel", () => {
  it("resizes to the right and clamps both bounds", () => {
    const { result } = renderHook(() =>
      useResizablePanel({ defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1, cssVariable: "--width" }),
    );
    const capture = resizeHandle();

    const preventDefault = startResize(result.current.onResizeStart, capture.handle);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(capture.setPointerCapture).toHaveBeenCalledWith(POINTER_ID);
    expect(document.body).toHaveClass("resizing");

    act(() => capture.handle.dispatchEvent(pointerEvent("pointermove", 500)));
    expect(capture.panel.style.getPropertyValue("--width")).toBe("400px");

    act(() => capture.handle.dispatchEvent(pointerEvent("pointermove", -100)));
    expect(capture.panel.style.getPropertyValue("--width")).toBe("220px");

    act(() => capture.handle.dispatchEvent(pointerEvent("pointerup")));
    expect(result.current.width).toBe(220);
  });

  it("resizes to the left and clamps both bounds", () => {
    const { result } = renderHook(() =>
      useResizablePanel({ defaultWidth: 318, minWidth: 280, maxWidth: 480, direction: -1, cssVariable: "--width" }),
    );
    const { handle, panel } = resizeHandle();
    startResize(result.current.onResizeStart, handle);

    act(() => handle.dispatchEvent(pointerEvent("pointermove", -100)));
    expect(panel.style.getPropertyValue("--width")).toBe("480px");

    act(() => handle.dispatchEvent(pointerEvent("pointermove", 200)));
    expect(panel.style.getPropertyValue("--width")).toBe("280px");

    act(() => handle.dispatchEvent(pointerEvent("pointerup")));
    expect(result.current.width).toBe(280);
  });

  it("does not render while dragging, only when the drag ends", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useResizablePanel({
        defaultWidth: 280,
        minWidth: 220,
        maxWidth: 400,
        direction: 1,
        cssVariable: "--width",
      });
    });
    const { handle } = resizeHandle();
    startResize(result.current.onResizeStart, handle);
    const rendersBeforeDrag = renders;

    act(() => handle.dispatchEvent(pointerEvent("pointermove", 120)));
    act(() => handle.dispatchEvent(pointerEvent("pointermove", 140)));
    expect(renders).toBe(rendersBeforeDrag);
    expect(result.current.width).toBe(280);

    act(() => handle.dispatchEvent(pointerEvent("pointerup")));
    expect(renders).toBe(rendersBeforeDrag + 1);
    expect(result.current.width).toBe(320);
  });

  it("reports the final width once a drag ends", () => {
    const onResizeEnd = vi.fn();
    const { result } = renderHook(() =>
      useResizablePanel({
        defaultWidth: 400,
        minWidth: 280,
        maxWidth: 480,
        direction: -1,
        cssVariable: "--width",
        onResizeEnd,
      }),
    );
    const { handle } = resizeHandle();
    startResize(result.current.onResizeStart, handle);

    act(() => handle.dispatchEvent(pointerEvent("pointermove", 80)));
    act(() => handle.dispatchEvent(pointerEvent("pointermove", 60)));
    expect(onResizeEnd).not.toHaveBeenCalled();

    act(() => handle.dispatchEvent(pointerEvent("pointerup")));
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(440);
  });

  it("does not report a click that leaves the width unchanged", () => {
    const onResizeEnd = vi.fn();
    const { result } = renderHook(() =>
      useResizablePanel({
        defaultWidth: 280,
        minWidth: 220,
        maxWidth: 400,
        direction: 1,
        cssVariable: "--width",
        onResizeEnd,
      }),
    );
    const { handle } = resizeHandle();
    startResize(result.current.onResizeStart, handle);

    act(() => handle.dispatchEvent(pointerEvent("pointerup")));
    expect(onResizeEnd).not.toHaveBeenCalled();
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])("cleans up after %s", (eventType) => {
    const { result } = renderHook(() =>
      useResizablePanel({ defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1, cssVariable: "--width" }),
    );
    const capture = resizeHandle();
    startResize(result.current.onResizeStart, capture.handle);

    act(() => capture.handle.dispatchEvent(pointerEvent(eventType)));

    expect(document.body).not.toHaveClass("resizing");
    expect(capture.releasePointerCapture).toHaveBeenCalledOnce();
    act(() => capture.handle.dispatchEvent(pointerEvent("pointermove", 150)));
    expect(result.current.width).toBe(280);
  });

  it("cleans up on window blur", () => {
    const { result } = renderHook(() =>
      useResizablePanel({ defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1, cssVariable: "--width" }),
    );
    const capture = resizeHandle();
    startResize(result.current.onResizeStart, capture.handle);

    act(() => window.dispatchEvent(new Event("blur")));

    expect(document.body).not.toHaveClass("resizing");
    expect(capture.releasePointerCapture).toHaveBeenCalledOnce();
  });

  it("cleans up on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useResizablePanel({ defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1, cssVariable: "--width" }),
    );
    const capture = resizeHandle();
    startResize(result.current.onResizeStart, capture.handle);

    unmount();

    expect(document.body).not.toHaveClass("resizing");
    expect(capture.releasePointerCapture).toHaveBeenCalledOnce();
  });

  it("cleans up and ignores resize starts when disabled", () => {
    const options = { defaultWidth: 280, minWidth: 220, maxWidth: 400, direction: 1 as const, cssVariable: "--width" };
    const { result, rerender } = renderHook(({ enabled }) => useResizablePanel({ ...options, enabled }), {
      initialProps: { enabled: true },
    });
    const firstCapture = resizeHandle();
    startResize(result.current.onResizeStart, firstCapture.handle);

    rerender({ enabled: false });

    expect(document.body).not.toHaveClass("resizing");
    expect(firstCapture.releasePointerCapture).toHaveBeenCalledOnce();

    const disabledCapture = resizeHandle();
    const preventDefault = startResize(result.current.onResizeStart, disabledCapture.handle);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(disabledCapture.setPointerCapture).not.toHaveBeenCalled();
  });
});
