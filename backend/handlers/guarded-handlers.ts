import type { BackendResult } from "../../shared/contracts.js";
import { sanitizeBackendError } from "../backend-error.js";

/** What a handler may know about who sent a request: approvals are bound to the requester that showed them. */
export interface HandlerEvent {
  readonly sender: { readonly id: number };
}

/** Where handlers are registered: Electron's `ipcMain`, or a host's own operation table. */
export interface HandlerRouter {
  handle(channel: string, listener: (event: HandlerEvent, payload: unknown) => Promise<BackendResult<unknown>>): void;
  removeHandler(channel: string): void;
}

export type SenderAuthorizer = (event: HandlerEvent) => boolean;

/** Returns the value to send back, or throws to report a sanitized error. */
export type GuardedHandler = (payload: unknown, event: HandlerEvent) => unknown;
type ResultHandler = (payload: unknown, event: HandlerEvent) => Promise<BackendResult<unknown>>;

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
 * answers only authorized senders; others get the same opaque invalid-request
 * error as a malformed payload.
 */
export function registerAuthorizedHandlers(
  router: HandlerRouter,
  authorizeSender: SenderAuthorizer,
  handlers: ReadonlyArray<readonly [string, ResultHandler]>,
): { dispose: () => void } {
  for (const [channel, handler] of handlers) {
    router.handle(channel, (event: HandlerEvent, payload: unknown) =>
      authorizeSender(event) ? handler(payload, event) : Promise.resolve(unauthorizedResult()),
    );
  }
  return {
    dispose: () => {
      for (const [channel] of handlers) router.removeHandler(channel);
    },
  };
}

/**
 * Registers sender-checked handlers and converts their return values and
 * exceptions into sanitized `BackendResult`s, so no channel can skip the sender
 * check or leak an exception across the process boundary.
 */
export function registerGuardedHandlers(
  router: HandlerRouter,
  authorizeSender: SenderAuthorizer,
  handlers: ReadonlyArray<readonly [string, GuardedHandler]>,
): { dispose: () => void } {
  return registerAuthorizedHandlers(
    router,
    authorizeSender,
    handlers.map(([channel, handler]) => [channel, (payload, event) => toBackendResult(() => handler(payload, event))]),
  );
}
