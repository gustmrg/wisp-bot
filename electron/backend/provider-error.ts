const GENERIC_PROVIDER_ERROR = "The model request failed. Please try again.";

const STATUS_PATTERN = /(?:^|\D)(4\d\d|5\d\d)(?:\D|$)/;

const TRANSIENT_PATTERN =
  /rate.?limit|too many requests|overload|service.?unavailable|server.?error|internal.?error|network|connection|timed? out|timeout|fetch failed|try again|please retry/i;

const CONNECTION_PATTERN = /network|connection|fetch failed|timed? out|timeout|econnrefused|enotfound|econnreset/i;

const STATUS_MESSAGES: Record<number, string> = {
  400: "The provider rejected the request. Check the model settings and try again.",
  401: "The provider rejected the credentials. Check the API key in the model settings.",
  402: "The provider requires payment for this model. Add credits or choose a different model.",
  403: "The provider denied access to this model. Check the API key or choose a different model.",
  404: "This model is unavailable. Choose a different model in the model settings.",
  408: "The provider took too long to respond. Please try again.",
  409: "The provider could not process the request right now. Please try again.",
  413: "The request was too large for this model. Shorten the conversation and try again.",
  425: "The provider could not process the request right now. Please try again.",
  429: "The provider is rate limiting requests. Please try again in a moment.",
};

export function isRetryableProviderError(message: string): boolean {
  const status = message.match(STATUS_PATTERN)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
  }
  return TRANSIENT_PATTERN.test(message);
}

/**
 * Turns a raw provider error (e.g. `OpenRouter API error (404): {"message":…,"code":404}`)
 * into a short user-facing sentence, classified by HTTP status. The raw text travels with the
 * error as `detail` for logging only.
 */
export function describeProviderError(raw: string): { message: string; retryable: boolean } {
  const detail = raw.trim();
  if (!detail) return { message: GENERIC_PROVIDER_ERROR, retryable: true };
  const status = Number(detail.match(STATUS_PATTERN)?.[1] ?? 0);
  const message =
    STATUS_MESSAGES[status] ??
    (status >= 500
      ? "The provider is having temporary issues. Please try again in a moment."
      : CONNECTION_PATTERN.test(detail)
        ? "Could not reach the provider. Check your connection and try again."
        : TRANSIENT_PATTERN.test(detail)
          ? "The provider is temporarily unavailable. Please try again in a moment."
          : GENERIC_PROVIDER_ERROR);
  return { message, retryable: isRetryableProviderError(detail) };
}
