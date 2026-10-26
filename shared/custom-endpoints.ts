/**
 * Endpoints the person adds that speak the OpenAI chat completions API, such
 * as Ollama, LM Studio, vLLM, llama.cpp, or a proxy (ADR 031). Each one is a
 * provider of its own whose models run on Pi.
 */

/** Provider IDs of custom endpoints start with this; no provider in Pi's catalog does. */
export const CUSTOM_ENDPOINT_PREFIX = "custom-";

export const MAX_CUSTOM_ENDPOINTS = 20;
export const MAX_CUSTOM_ENDPOINT_MODELS = 50;
export const MAX_CUSTOM_ENDPOINT_NAME_LENGTH = 60;
export const MAX_CUSTOM_ENDPOINT_URL_LENGTH = 500;

/** What a new model gets until the person says otherwise; most local servers default to less. */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 32_768;
export const DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS = 8_192;
export const MIN_CUSTOM_CONTEXT_WINDOW = 1_024;
export const MAX_CUSTOM_CONTEXT_WINDOW = 10_000_000;

export function isCustomEndpointId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_ENDPOINT_PREFIX);
}

export interface CustomEndpointModel {
  /** The model's ID as the endpoint names it, such as `qwen2.5-coder:7b`. */
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Whether the model accepts images; the person says so, since endpoints do not report it. */
  images: boolean;
}

export interface CustomEndpointView {
  /** Its provider ID, `custom-` and a random suffix. */
  id: string;
  name: string;
  /** The OpenAI-compatible base URL, such as `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Whether an encrypted key is saved for it; endpoints without one are called without a key. */
  keySaved: boolean;
  models: ReadonlyArray<CustomEndpointModel>;
}

export interface SaveCustomEndpointRequest {
  /** Missing to add an endpoint. */
  id?: string;
  name: string;
  baseUrl: string;
  /** A new key; the saved one is kept when missing. */
  apiKey?: string;
  /** Removes the saved key. */
  removeKey?: boolean;
  models: ReadonlyArray<CustomEndpointModel>;
}

export interface RemoveCustomEndpointRequest {
  id: string;
}

export interface LoadCustomEndpointModelsRequest {
  baseUrl: string;
  /** A key typed into the form, not yet saved. */
  apiKey?: string;
  /** A saved endpoint whose key may be used, at its own address only. */
  id?: string;
}

export interface CustomEndpointModelsView {
  /** The model IDs the endpoint lists. */
  models: ReadonlyArray<string>;
}

/** A model server found on the server's computer at its usual address. */
export interface DetectedEndpoint {
  name: string;
  baseUrl: string;
  models: ReadonlyArray<string>;
}

export interface DetectedEndpointsView {
  endpoints: ReadonlyArray<DetectedEndpoint>;
}
