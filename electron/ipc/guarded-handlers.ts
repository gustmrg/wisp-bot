import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { BackendResult } from "../../shared/contracts.js";
import { sanitizeBackendError } from "../../backend/backend-error.js";

export type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
export type SenderAuthorizer = (event: IpcMainInvokeEvent) => boolean;

/** Returns the value to send back, or throws to report a sanitized error. */
export type GuardedHandler = (payload: unknown, event: IpcMainInvokeEvent) => unknown;
type ResultHandler = (payload: unknown, event: IpcMainInvokeEvent) => Promise<BackendResult<unknown>>;

export async function toBackendResult<T>(operation: () => Promise<T> | T): Promise<BackendResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: sanitizeBackendError(error) };
  }
}

function unauthorizedResult(): BackendResult<never> {
  return {
    ok: false,
    error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
  };
}

/**
 * Registers handlers whose results are already `BackendResult`s. Every channel
 * answers only the trusted renderer; others get the same opaque invalid-request
 * error as a malformed payload.
 */
export function registerAuthorizedHandlers(
  ipcMain: HandlerIpcMain,
  authorizeSender: SenderAuthorizer,
  handlers: ReadonlyArray<readonly [string, ResultHandler]>,
): { dispose: () => void } {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) =>
      authorizeSender(event) ? handler(payload, event) : Promise.resolve(unauthorizedResult()),
    );
  }
  return {
    dispose: () => {
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
    },
  };
}

/**
 * Registers sender-checked handlers and converts their return values and
 * exceptions into sanitized `BackendResult`s, so no channel can skip the sender
 * check or leak an exception across the process boundary.
 */
export function registerGuardedHandlers(
  ipcMain: HandlerIpcMain,
  authorizeSender: SenderAuthorizer,
  handlers: ReadonlyArray<readonly [string, GuardedHandler]>,
): { dispose: () => void } {
  return registerAuthorizedHandlers(
    ipcMain,
    authorizeSender,
    handlers.map(([channel, handler]) => [channel, (payload, event) => toBackendResult(() => handler(payload, event))]),
  );
}
