import { readFile } from "node:fs/promises";

import { writeFileAtomically } from "./atomic-file.js";

const SUPPORTED_PROVIDER_IDS = new Set(["openrouter"]);
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CACHE_SCHEMA_VERSION = 1;

export interface ModelPricing {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheReadPerMillionTokens: number;
}

interface PersistedPricingCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  cachedAt: number;
  models: Record<string, ModelPricing>;
}

export interface ModelPricingServiceOptions {
  cacheFilePath: string;
  ttlMs?: number;
  fetchTimeoutMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  fetchModels?: (url: string, timeoutMs: number) => Promise<unknown>;
}

export class ModelPricingService {
  private readonly cacheFilePath: string;
  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly fetchModels: (url: string, timeoutMs: number) => Promise<unknown>;
  private pricing: Record<string, ModelPricing> = {};
  private cachedAt = 0;
  private loaded = false;
  private lastFetchAttemptAt = 0;
  private loading: Promise<void> | null = null;

  constructor(options: ModelPricingServiceOptions) {
    this.cacheFilePath = options.cacheFilePath;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.fetchModels = options.fetchModels ?? fetchOpenRouterModels;
  }

  async ensureFresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  getPricing(providerId: string, modelId: string): ModelPricing | null {
    if (!SUPPORTED_PROVIDER_IDS.has(providerId)) return null;
    return this.pricing[modelId] ?? null;
  }

  private async load(): Promise<void> {
    await this.readCache();
    if (this.loaded && this.now().getTime() - this.cachedAt < this.ttlMs) return;
    if (this.now().getTime() - this.lastFetchAttemptAt < this.retryDelayMs) return;
    this.lastFetchAttemptAt = this.now().getTime();
    try {
      const payload = await this.fetchModels(OPENROUTER_MODELS_URL, this.fetchTimeoutMs);
      const models = parseOpenRouterModels(payload);
      this.pricing = models;
      this.cachedAt = this.now().getTime();
      this.loaded = true;
      await writeFileAtomically(this.cacheFilePath, this.serializeCache()).catch(() => undefined);
    } catch {
      // Pricing is best-effort; stale cache (or none) still produces a report without cost.
    }
  }

  private async readCache(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.cacheFilePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = parsePersistedCache(JSON.parse(contents));
      if (this.loaded && this.cachedAt >= parsed.cachedAt) return;
      this.pricing = parsed.models;
      this.cachedAt = parsed.cachedAt;
      this.loaded = true;
    } catch {
      // Corrupt pricing cache is ignored; the next fetch replaces it.
    }
  }

  private serializeCache(): string {
    const cache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachedAt: new Date(this.cachedAt).toISOString(),
      models: this.pricing,
    };
    return `${JSON.stringify(cache)}\n`;
  }
}

async function fetchOpenRouterModels(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`The pricing endpoint returned ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error("The pricing response is too large.");
  return response.json();
}

function parsePersistedCache(value: unknown): PersistedPricingCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pricing cache");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CACHE_SCHEMA_VERSION) throw new Error("Invalid pricing cache");
  const cachedAt = typeof raw.cachedAt === "string" ? Date.parse(raw.cachedAt) : Number.NaN;
  if (!Number.isFinite(cachedAt)) throw new Error("Invalid pricing cache");
  if (!raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    throw new Error("Invalid pricing cache");
  }
  const models: Record<string, ModelPricing> = {};
  for (const [modelId, pricingValue] of Object.entries(raw.models as Record<string, unknown>)) {
    if (!modelId || modelId.length > 256) continue;
    const pricing = pricingValue as Record<string, unknown>;
    const candidate: ModelPricing = {
      inputPerMillionTokens: Number(pricing?.inputPerMillionTokens),
      outputPerMillionTokens: Number(pricing?.outputPerMillionTokens),
      cacheReadPerMillionTokens: Number(pricing?.cacheReadPerMillionTokens),
    };
    if (!Number.isFinite(candidate.inputPerMillionTokens) || !Number.isFinite(candidate.outputPerMillionTokens)) {
      continue;
    }
    if (!Number.isFinite(candidate.cacheReadPerMillionTokens)) candidate.cacheReadPerMillionTokens = 0;
    models[modelId] = candidate;
  }
  return { schemaVersion: CACHE_SCHEMA_VERSION, cachedAt, models };
}

function parseOpenRouterModels(payload: unknown): Record<string, ModelPricing> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return {};
  const models: Record<string, ModelPricing> = {};
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const modelId = record.id;
    if (typeof modelId !== "string" || !modelId || modelId.length > 256) continue;
    const pricing = parseOpenRouterPricing(record.pricing);
    if (pricing) models[modelId] = pricing;
  }
  return models;
}

function parseOpenRouterPricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputPerToken = parseUsdPerToken(record.prompt);
  const outputPerToken = parseUsdPerToken(record.completion);
  const cacheReadPerToken = parseUsdPerToken(record.input_cache_read);
  if (inputPerToken === null || outputPerToken === null) return null;
  return {
    inputPerMillionTokens: inputPerToken * 1_000_000,
    outputPerMillionTokens: outputPerToken * 1_000_000,
    cacheReadPerMillionTokens: (cacheReadPerToken ?? 0) * 1_000_000,
  };
}

function parseUsdPerToken(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
