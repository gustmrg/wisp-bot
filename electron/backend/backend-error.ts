import type { BackendError, BackendErrorCode } from "../../shared/contracts.js";

export class WispBackendError extends Error {
  readonly code: BackendErrorCode;
  readonly retryable: boolean;

  constructor(code: BackendErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WispBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function sanitizeBackendError(error: unknown): BackendError {
  if (error instanceof WispBackendError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  return {
    code: "internal_error",
    message: "The backend could not complete the request.",
    retryable: true,
  };
}
