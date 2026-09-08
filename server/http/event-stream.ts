import type { ServerResponse } from "node:http";
import type { ServerDatabase } from "../storage/database.js";
import type { DeviceAuth, DevicePrincipal } from "../auth/device-auth.js";

/** Replay and live delivery share the same committed outbox; no publication race. */
export function eventStream(
  response: ServerResponse,
  database: ServerDatabase,
  auth: DeviceAuth,
  principal: DevicePrincipal,
  cursor: string,
): () => void {
  database.eventsAfter(cursor, 1); // Validate before committing HTTP headers.
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write(": connected\n\n");
  let closed = false,
    pumping = false,
    scheduled = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
    unrevoke();
    response.end();
  };
  const pump = (): void => {
    if (closed || pumping) return;
    pumping = true;
    try {
      let count = 0;
      while (count < 1024) {
        const events = database.eventsAfter(cursor);
        if (!events.length) break;
        for (const event of events) {
          if (response.writableLength > 256 * 1024) {
            response.write("event: resync_required\ndata: {}\n\n");
            close();
            return;
          }
          const writable = response.write(`id: ${event.eventId}\nevent: wisp\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.eventId;
          count++;
          if (!writable) {
            if (response.writableLength > 256 * 1024) close();
            else response.once("drain", schedule);
            return;
          }
        }
      }
      if (count >= 1024) schedule();
    } catch {
      response.write("event: resync_required\ndata: {}\n\n");
      close();
    } finally {
      pumping = false;
    }
  };
  const schedule = (): void => {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  };
  const unsubscribe = database.onCommit(schedule);
  const unrevoke = auth.onRevoke((id) => {
    if (id === principal.deviceId) close();
  });
  const heartbeat = setInterval(() => {
    if (response.writableLength > 256 * 1024) close();
    else response.write(": heartbeat\n\n");
  }, 15_000);
  const expiry = setTimeout(close, Math.max(1, Date.parse(principal.expiresAt) - Date.now()));
  response.once("close", close);
  schedule();
  return close;
}
