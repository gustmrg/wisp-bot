export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function invalidRequest(): never {
  throw new HttpError(400, "invalid_request", "The request is invalid.");
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest();
  return value as Record<string, unknown>;
}

export function boundedString(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalidRequest();
  return value as string;
}
