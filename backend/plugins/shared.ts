import type { BackendErrorCode } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { PluginToolSpec } from "../plugin-types.js";

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_OUTPUT_CHARS = 32_000;

export type Fields = Record<string, unknown>;

export class PluginRequestError extends WispBackendError {
  constructor(message: string, code: BackendErrorCode = "internal_error") {
    super(code, message);
  }
}

export function object(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

export function params(value: unknown, allowed: string[]): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WispBackendError("invalid_request", "Tool arguments must be an object.");
  }
  const result = value as Fields;
  if (Object.keys(result).some((key) => !allowed.includes(key))) {
    throw new WispBackendError("invalid_request", "Unsupported tool argument.");
  }
  return result;
}

export function stringField(
  values: Fields,
  key: string,
  max: number,
  optional = false,
  allowEmpty = false,
): string | undefined {
  const value = values[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new WispBackendError(
      "invalid_request",
      `Invalid ${key}: expected ${allowEmpty ? "a" : "a non-empty"} string of at most ${max} characters.`,
    );
  }
  return allowEmpty ? value : value.trim();
}

export function integerField(
  values: Fields,
  key: string,
  min: number,
  max: number,
  fallback?: number,
): number | undefined {
  const value = values[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WispBackendError("invalid_request", `Invalid ${key}: expected an integer from ${min} to ${max}.`);
  }
  return value;
}

export function textField(value: unknown, max = 500): string | null {
  return typeof value === "string" ? (value.length > max ? `${value.slice(0, max)}… [truncated]` : value) : null;
}

export function output(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_OUTPUT_CHARS) return serialized;
  // Keep every identifier, source URL and pagination cursor intact when reducing text.
  for (const maxText of [1_000, 250, 60]) {
    const compact = JSON.stringify({ ...object(value), truncated: true }, (key, item: unknown) =>
      ["title", "description", "name", "snippet", "markdown", "body"].includes(key) && typeof item === "string"
        ? textField(item, maxText)
        : item,
    );
    if (compact.length <= MAX_OUTPUT_CHARS) return compact;
  }
  throw new PluginRequestError("The result exceeds the output limit. Narrow the search or request fewer results.");
}

export function schema(properties: Fields, required: string[] = []): PluginToolSpec["parameters"] {
  return { type: "object", properties, required, additionalProperties: false } as PluginToolSpec["parameters"];
}

export async function requestJson(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Fields> {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    combinedSignal.throwIfAborted();
    const response = await fetch(url, { ...init, signal: combinedSignal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const hint =
        response.status === 401 || response.status === 403
          ? " Check the API key and its permissions."
          : response.status === 429
            ? " Rate limit reached."
            : "";
      throw new PluginRequestError(
        `${provider} request failed (HTTP ${response.status}).${hint}`,
        response.status === 401 || response.status === 403 ? "invalid_configuration" : "internal_error",
      );
    }
    if (!response.body) throw new PluginRequestError(`${provider} returned an empty response.`);
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new PluginRequestError(`${provider} response is too large. Narrow the request.`);
    }
    const reader = response.body.getReader();
    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };
    combinedSignal.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    try {
      while (true) {
        combinedSignal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new PluginRequestError(`${provider} response is too large. Narrow the request.`);
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      combinedSignal.throwIfAborted();
    } finally {
      combinedSignal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
    return object(JSON.parse(body));
  } catch (error) {
    if (signal?.aborted) throw new PluginRequestError(`${provider} request cancelled.`, "aborted");
    if (controller.signal.aborted) throw new PluginRequestError(`${provider} request timed out.`);
    if (error instanceof PluginRequestError) throw error;
    // Fetch/JSON errors can contain URLs, provider payloads, or credentials.
    throw new PluginRequestError(`${provider} request failed. Check the connection.`);
  } finally {
    clearTimeout(timeout);
  }
}
