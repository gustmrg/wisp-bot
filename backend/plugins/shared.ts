import { z } from "zod";

import type { BackendErrorCode } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { PluginToolSpec } from "../plugin-types.js";
import { parseToolArguments, toolParameters } from "../tool-schema.js";

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

/**
 * A bundled plugin tool as it is written: parameters as a zod schema, whose
 * parsed arguments `summarize` and `execute` receive.
 */
export interface PluginToolDraft<TSchema extends z.ZodType>
  extends Omit<PluginToolSpec, "parameters" | "summarize" | "execute"> {
  parameters: TSchema;
  summarize(params: z.output<TSchema>): string;
  execute(credential: string, params: z.output<TSchema>, signal?: AbortSignal, endpoint?: string): Promise<string>;
}

/**
 * The tool as the plugin service runs it: the parameters as JSON Schema, and
 * `summarize` and `execute` parsing the arguments first, so invalid ones fail
 * before an approval is asked for or a request is sent.
 */
export function pluginTool<TSchema extends z.ZodType>(draft: PluginToolDraft<TSchema>): PluginToolSpec {
  const { parameters, summarize, execute, ...rest } = draft;
  return {
    ...rest,
    parameters: toolParameters(parameters),
    summarize: (raw) => summarize(parseToolArguments(parameters, raw)),
    execute: async (credential, raw, signal, endpoint) =>
      execute(credential, parseToolArguments(parameters, raw), signal, endpoint),
  };
}

/**
 * A string argument, trimmed, that must not be blank. `minLength` is only what
 * the model is told (none when null), so a field that is told it may be empty
 * still is not.
 */
export function textArgument(max: number, description?: string, minLength: number | null = 1) {
  const message = `expected a non-empty string of at most ${max} characters.`;
  const string = z.string({ error: message });
  const schema = (minLength === null ? string : string.min(minLength, message))
    .max(max, message)
    .trim()
    .refine((value) => value !== "", message);
  return description ? schema.describe(description) : schema;
}

/** A string argument that may be empty, kept as written. */
export function emptyableTextArgument(max: number, description?: string, minLength?: number) {
  const message = `expected a string of at most ${max} characters.`;
  const string = z.string({ error: message });
  const schema = (minLength === undefined ? string : string.min(minLength, message)).max(max, message);
  return description ? schema.describe(description) : schema;
}

export function integerArgument(min: number, max: number, description?: string) {
  const message = `expected an integer from ${min} to ${max}.`;
  const schema = z.int({ error: message }).min(min, message).max(max, message);
  return description ? schema.describe(description) : schema;
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

export async function requestJson(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  /** What to check when the provider refuses the credential (HTTP 401 or 403). */
  authHint = "Check the API key and its permissions.",
): Promise<Fields> {
  const body = await requestText(provider, url, init, signal, authHint);
  try {
    return object(JSON.parse(body));
  } catch {
    throw new PluginRequestError(`${provider} request failed. Check the connection.`);
  }
}

/** The response body as text, with the same limits and error handling as `requestJson`. */
export async function requestText(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  authHint = "Check the API key and its permissions.",
): Promise<string> {
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
          ? ` ${authHint}`
          : response.status === 402
            ? " Check the account balance or credits."
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
    return body;
  } catch (error) {
    if (signal?.aborted) throw new PluginRequestError(`${provider} request cancelled.`, "aborted");
    if (controller.signal.aborted) throw new PluginRequestError(`${provider} request timed out.`);
    if (error instanceof PluginRequestError) throw error;
    // Fetch errors can contain URLs, provider payloads, or credentials.
    throw new PluginRequestError(`${provider} request failed. Check the connection.`);
  } finally {
    clearTimeout(timeout);
  }
}
