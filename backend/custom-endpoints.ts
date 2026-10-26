import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import { isModelId } from "../shared/contracts.js";
import {
  CUSTOM_ENDPOINT_PREFIX,
  MAX_CUSTOM_CONTEXT_WINDOW,
  MAX_CUSTOM_ENDPOINT_MODELS,
  MAX_CUSTOM_ENDPOINT_NAME_LENGTH,
  MAX_CUSTOM_ENDPOINT_URL_LENGTH,
  MAX_CUSTOM_ENDPOINTS,
  MIN_CUSTOM_CONTEXT_WINDOW,
  type CustomEndpointModel,
  type DetectedEndpoint,
} from "../shared/custom-endpoints.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";

const ID_PATTERN = new RegExp(`^${CUSTOM_ENDPOINT_PREFIX}[0-9a-f]{8}$`);
const MODELS_TIMEOUT_MS = 5_000;
const DETECT_TIMEOUT_MS = 1_500;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_LISTED_MODELS = 500;

/**
 * What Pi sends as the key of an endpoint without one, which local servers
 * ignore. A saved key comes from the credential store and wins over it. Pi
 * runs `!command` and expands `$NAME` in a configured key, so the person's
 * key is never configured here.
 */
export const KEYLESS_API_KEY = "wisp-no-key";

/** Where the usual local model servers listen, on the computer that runs Wisp. */
export const LOCAL_ENDPOINT_CANDIDATES: ReadonlyArray<{ name: string; baseUrl: string }> = [
  { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
];

type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

export interface StoredCustomEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomEndpointModel[];
}

interface StoreFile {
  schemaVersion: 1;
  endpoints: StoredCustomEndpoint[];
}

export function newCustomEndpointId(): string {
  return `${CUSTOM_ENDPOINT_PREFIX}${randomBytes(4).toString("hex")}`;
}

export function isStoredCustomEndpointId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * An http(s) base URL without credentials, query, or fragment, and without a
 * trailing slash, or null when the value is not one.
 */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CUSTOM_ENDPOINT_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

export function normalizeEndpointName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= MAX_CUSTOM_ENDPOINT_NAME_LENGTH && !/\p{Cc}/u.test(name) ? name : null;
}

export function normalizeEndpointModel(value: unknown): CustomEndpointModel | null {
  if (!value || typeof value !== "object") return null;
  const { id, contextWindow, maxOutputTokens, images } = value as Partial<Record<keyof CustomEndpointModel, unknown>>;
  if (!isModelId(id) || typeof images !== "boolean") return null;
  if (
    !Number.isSafeInteger(contextWindow) ||
    (contextWindow as number) < MIN_CUSTOM_CONTEXT_WINDOW ||
    (contextWindow as number) > MAX_CUSTOM_CONTEXT_WINDOW
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    (maxOutputTokens as number) < 1 ||
    (maxOutputTokens as number) > (contextWindow as number)
  ) {
    return null;
  }
  return { id, contextWindow: contextWindow as number, maxOutputTokens: maxOutputTokens as number, images };
}

/** The models of an endpoint, each once, or null when one is invalid or there are none or too many. */
export function normalizeEndpointModels(value: unknown): CustomEndpointModel[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CUSTOM_ENDPOINT_MODELS) return null;
  const models = value.map(normalizeEndpointModel);
  if (models.some((model) => !model)) return null;
  const ids = new Set(models.map((model) => model!.id));
  return ids.size === models.length ? (models as CustomEndpointModel[]) : null;
}

function normalizeStoredEndpoint(value: unknown): StoredCustomEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = normalizeEndpointName(record.name);
  const baseUrl = normalizeBaseUrl(record.baseUrl);
  const models = normalizeEndpointModels(record.models);
  if (!isStoredCustomEndpointId(record.id) || !name || !baseUrl || !models) return null;
  return { id: record.id, name, baseUrl, models };
}

/** The endpoint as Pi registers it: a provider of its own on the OpenAI chat completions API. */
export function piProviderConfig(endpoint: StoredCustomEndpoint): PiProviderConfig {
  return {
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    api: "openai-completions",
    apiKey: KEYLESS_API_KEY,
    models: endpoint.models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: false,
      input: model.images ? ["text", "image"] : ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
}

/**
 * The endpoints added on this server, in the order they were added. Their
 * keys stay in the encrypted credential store, under each endpoint's ID.
 */
export class CustomEndpointStore {
  private endpoints: StoredCustomEndpoint[] | undefined;

  constructor(private readonly filePath: string) {}

  async list(): Promise<StoredCustomEndpoint[]> {
    return structuredClone(await this.load());
  }

  async save(endpoints: ReadonlyArray<StoredCustomEndpoint>): Promise<void> {
    if (endpoints.length > MAX_CUSTOM_ENDPOINTS) {
      throw new WispBackendError("invalid_request", `Add at most ${MAX_CUSTOM_ENDPOINTS} custom endpoints.`);
    }
    const file: StoreFile = { schemaVersion: 1, endpoints: structuredClone([...endpoints]) };
    await writeFileAtomically(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
    this.endpoints = file.endpoints;
  }

  private async load(): Promise<StoredCustomEndpoint[]> {
    if (this.endpoints) return this.endpoints;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreFile>;
      // A file a newer version wrote, or one that is damaged, keeps what can still be read.
      const entries = parsed.schemaVersion === 1 && Array.isArray(parsed.endpoints) ? parsed.endpoints : [];
      this.endpoints = entries
        .map(normalizeStoredEndpoint)
        .filter((endpoint): endpoint is StoredCustomEndpoint => endpoint !== null)
        .slice(0, MAX_CUSTOM_ENDPOINTS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.endpoints = [];
    }
    return this.endpoints;
  }
}

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new WispBackendError("invalid_configuration", "The endpoint's model list is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The model IDs an OpenAI-compatible endpoint lists at `/models`. The key,
 * when there is one, goes to the endpoint's own address only: a redirect is
 * refused rather than followed.
 */
export async function fetchEndpointModels(
  baseUrl: string,
  apiKey: string | undefined,
  { fetch = globalThis.fetch, timeoutMs = MODELS_TIMEOUT_MS }: { fetch?: FetchFunction; timeoutMs?: number } = {},
): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WispBackendError(
      "unavailable",
      `Could not reach ${origin}. Check the address and that the server is running.`,
      true,
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new WispBackendError("invalid_configuration", "The endpoint refused the request. Check its API key.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new WispBackendError("unavailable", `The endpoint answered with status ${response.status}.`, true);
  }
  let body: unknown;
  try {
    body = JSON.parse(await readLimited(response, MAX_MODELS_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof WispBackendError) throw error;
    throw new WispBackendError(
      "invalid_configuration",
      "The endpoint did not answer with an OpenAI-compatible model list.",
    );
  }
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new WispBackendError(
      "invalid_configuration",
      "The endpoint did not answer with an OpenAI-compatible model list.",
    );
  }
  const ids = data.map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined));
  return [...new Set(ids.filter(isModelId))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_LISTED_MODELS);
}

/** The usual local model servers that answer on this computer, with the models each lists; none needs a key. */
export async function detectLocalEndpoints({
  fetch = globalThis.fetch,
  candidates = LOCAL_ENDPOINT_CANDIDATES,
}: {
  fetch?: FetchFunction;
  candidates?: ReadonlyArray<{ name: string; baseUrl: string }>;
} = {}): Promise<DetectedEndpoint[]> {
  const found = await Promise.all(
    candidates.map(async ({ name, baseUrl }): Promise<DetectedEndpoint | null> => {
      try {
        return {
          name,
          baseUrl,
          models: await fetchEndpointModels(baseUrl, undefined, { fetch, timeoutMs: DETECT_TIMEOUT_MS }),
        };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((endpoint): endpoint is DetectedEndpoint => endpoint !== null);
}
