import { WispBackendError } from "../backend-error.js";
import type { PluginAdapter } from "../plugin-types.js";
import { type Fields, object, output, PluginRequestError, requestJson, textField } from "./shared.js";
import { pageOutput, readInput, searchInput, webReadTool, webSearchTool } from "./web.js";

// DeepSeek counts Unicode characters and rejects longer queries with HTTP 400.
const MAX_QUERY_CHARS = 128;

async function deepseekRequest(apiKey: string, path: "search" | "fetch", body: Fields, signal?: AbortSignal) {
  return requestJson(
    "DeepSeek",
    `https://api.deepseek.com/v1/tools/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    signal,
    // Fetch answers 403 when its security policy rejects the page, not only for a bad key.
    path === "fetch"
      ? "Check the API key, or the page may be blocked by DeepSeek's access policy."
      : "Check the API key and its permissions.",
  );
}

async function search(apiKey: string, query: string, count: number, signal?: AbortSignal) {
  const data = await deepseekRequest(apiKey, "search", { query, count }, signal);
  if (!Array.isArray(data.results)) throw new PluginRequestError("DeepSeek returned an invalid search result.");
  return data.results;
}

export const deepseek: PluginAdapter = {
  id: "deepseek",
  tools: [
    webSearchTool(async (apiKey, raw, signal) => {
      const { query, count } = searchInput(raw);
      if (Array.from(query).length > MAX_QUERY_CHARS)
        throw new WispBackendError(
          "invalid_request",
          `Invalid query: DeepSeek search accepts at most ${MAX_QUERY_CHARS} characters. Use a shorter query.`,
        );
      const results = await search(apiKey, query, count, signal);
      return output({
        provider: "deepseek",
        query,
        results: results.slice(0, count).map((value) => {
          const result = object(value);
          return {
            title: textField(result.title, 200),
            url: textField(result.url, 1_000),
            // The model-oriented summary is longer than the UI snippet; fall back when it is missing.
            snippet: textField(result.summary || result.snippet, 1_500),
          };
        }),
        moreResultsAvailable: null,
      });
    }),
    webReadTool(async (apiKey, raw, signal) => {
      const { url, normalizedUrl } = readInput(raw);
      const page = await deepseekRequest(apiKey, "fetch", { url: normalizedUrl }, signal);
      if (typeof page.content !== "string" || !page.content.trim())
        throw new PluginRequestError("DeepSeek could not read this page. Check the URL and its accessibility.");
      return pageOutput("deepseek", url, page.title || null, page.content);
    }),
  ],
  testConnection: async (apiKey, signal) => {
    await search(apiKey, "DeepSeek", 1, signal);
    return "Connected to DeepSeek.";
  },
};
