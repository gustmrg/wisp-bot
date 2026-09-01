import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { ResizablePanelLayout } from "@/lib/layout";

interface UseResizablePanelOptions extends ResizablePanelLayout {
  readonly enabled?: boolean;
}

function clampWidth(width: number, minWidth: number, maxWidth: number) {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

function useResizablePanel({ defaultWidth, minWidth, maxWidth, direction, enabled = true }: UseResizablePanelOptions) {
  const [width, setWidth] = useState(defaultWidth);
  const cleanupRef = useRef<() => void>(() => undefined);

  const cancelResize = useCallback(() => cleanupRef.current(), []);

  useEffect(() => {
    if (!enabled) cancelResize();
  }, [cancelResize, enabled]);

  useEffect(() => cancelResize, [cancelResize]);

  const onResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;

      event.preventDefault();
      cancelResize();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = width;
      let captured = false;
      let cleaned = false;

      try {
        handle.setPointerCapture(pointerId);
        captured = true;
      } catch {
        // Older DOM implementations can expose the API without supporting capture.
      }

      const listenerTarget: EventTarget = captured ? handle : document;

      function move(moveEvent: Event) {
        const pointerEvent = moveEvent as PointerEvent;
        if (pointerEvent.pointerId !== pointerId) return;
        const delta = (pointerEvent.clientX - startX) * direction;
        setWidth(clampWidth(startWidth + delta, minWidth, maxWidth));
      }

      function stop(stopEvent: Event) {
        const pointerEvent = stopEvent as PointerEvent;
        if (pointerEvent.pointerId !== pointerId) return;
        cleanup();
      }

      function cleanup() {
        if (cleaned) return;
        cleaned = true;

        listenerTarget.removeEventListener("pointermove", move);
        listenerTarget.removeEventListener("pointerup", stop);
        listenerTarget.removeEventListener("pointercancel", stop);
        handle.removeEventListener("lostpointercapture", stop);
        window.removeEventListener("blur", cleanup);
        document.body.classList.remove("resizing");

        if (captured) {
          try {
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          } catch {
            // Capture may already have been released by the browser.
          }
        }

        if (cleanupRef.current === cleanup) cleanupRef.current = () => undefined;
      }

      cleanupRef.current = cleanup;
      document.body.classList.add("resizing");
      listenerTarget.addEventListener("pointermove", move);
      listenerTarget.addEventListener("pointerup", stop);
      listenerTarget.addEventListener("pointercancel", stop);
      if (captured) handle.addEventListener("lostpointercapture", stop);
      window.addEventListener("blur", cleanup);
    },
    [cancelResize, direction, enabled, maxWidth, minWidth, width],
  );

  return { onResizeStart, width };
}

export { useResizablePanel };
