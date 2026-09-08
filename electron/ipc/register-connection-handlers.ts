import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { CONNECTION_IPC_CHANNELS } from "../../shared/connections.js";
import type { BackendResult } from "../../shared/contracts.js";
import type { ConnectionManager } from "../connections/connection-manager.js";
import type { SenderAuthorizer } from "./register-handlers.js";

function parseRequest(value: unknown): { id: string; pairingCode?: string; fingerprint?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid connection request.");
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(request.id))
    throw new Error("Invalid connection ID.");
  if (
    request.pairingCode !== undefined &&
    (typeof request.pairingCode !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(request.pairingCode))
  )
    throw new Error("Invalid pairing code.");
  if (
    request.fingerprint !== undefined &&
    (typeof request.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(request.fingerprint))
  )
    throw new Error("Invalid host fingerprint.");
  return request as { id: string; pairingCode?: string; fingerprint?: string };
}
export function registerConnectionHandlers(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  manager: ConnectionManager,
  authorize: SenderAuthorizer,
): { dispose(): void } {
  const entries: Array<[string, (value: unknown) => unknown | Promise<unknown>]> = [
    [CONNECTION_IPC_CHANNELS.list, () => manager.list()],
    [CONNECTION_IPC_CHANNELS.save, (value) => manager.save(value)],
    [
      CONNECTION_IPC_CHANNELS.delete,
      async (value) => {
        await manager.delete(parseRequest(value).id);
        return {};
      },
    ],
    [CONNECTION_IPC_CHANNELS.connect, (value) => manager.connect(parseRequest(value))],
    [CONNECTION_IPC_CHANNELS.disconnect, () => manager.disconnect()],
    [CONNECTION_IPC_CHANNELS.getState, () => manager.getState()],
    [
      CONNECTION_IPC_CHANNELS.trustHost,
      async (value) => {
        const request = parseRequest(value);
        if (!request.fingerprint) throw new Error("A verified host fingerprint is required.");
        await manager.trustHost({ id: request.id, fingerprint: request.fingerprint });
        return {};
      },
    ],
    [
      CONNECTION_IPC_CHANNELS.openAuthentication,
      async () => {
        await manager.openAuthentication();
        return {};
      },
    ],
  ];
  for (const [channel, handler] of entries)
    ipc.handle(channel, async (event: IpcMainInvokeEvent, value: unknown): Promise<BackendResult<unknown>> => {
      if (!authorize(event))
        return {
          ok: false,
          error: { code: "invalid_request", message: "The connection request is invalid.", retryable: false },
        };
      try {
        return { ok: true, value: await handler(value) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "invalid_request",
            message:
              error instanceof Error && error.message.length < 500 ? error.message : "The connection operation failed.",
            retryable: false,
          },
        };
      }
    });
  return {
    dispose: () => {
      for (const [channel] of entries) ipc.removeHandler(channel);
    },
  };
}
