import type { RemoteTransportErrorCode } from "../shared/remote-protocol.js";

/** A transport failure answered with an HTTP status, as opposed to an operation's `BackendResult`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: RemoteTransportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function unauthorized(message = "Pair this device with the server first."): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function invalidRequest(message = "The request is invalid."): HttpError {
  return new HttpError(400, "invalid_request", message);
}

/** A non-empty string without control characters, at most `max` characters long. */
export function boundedString(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalidRequest();
  }
  return value;
}
