import type { PluginAdapter } from "../plugin-types.js";
import { type Fields, object, output, PluginRequestError, requestJson, textField } from "./shared.js";
import { pageOutput, webReadTool, webSearchTool } from "./web.js";

async function tavilyRequest(
  apiKey: string,
  path: "search" | "extract" | "usage",
  body?: Fields,
  signal?: AbortSignal,
) {
  return requestJson(
    "Tavily",
    `https://api.tavily.com/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    signal,
  );
}

export const tavily: PluginAdapter = {
  id: "tavily",
  tools: [
    webSearchTool(async (apiKey, { query, count }, signal) => {
      const data = await tavilyRequest(
        apiKey,
        "search",
        {
          query,
          max_results: count,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        },
        signal,
      );
      if (!Array.isArray(data.results)) throw new PluginRequestError("Tavily returned an invalid search result.");
      return output({
        provider: "tavily",
        query,
        results: data.results.slice(0, count).map((value) => {
          const result = object(value);
          return {
            title: textField(result.title, 200),
            url: textField(result.url, 1_000),
            snippet: textField(result.content, 1_500),
          };
        }),
        moreResultsAvailable: null,
      });
    }),
    webReadTool(async (apiKey, { url, normalizedUrl }, signal) => {
      const data = await tavilyRequest(
        apiKey,
        "extract",
        { urls: [normalizedUrl], format: "markdown", extract_depth: "basic", include_images: false, timeout: 20 },
        signal,
      );
      // Per-URL extraction failures can arrive with HTTP 200 and no results.
      const page = object(Array.isArray(data.results) && data.results.length === 1 ? data.results[0] : undefined);
      if (typeof page.raw_content !== "string")
        throw new PluginRequestError("Tavily could not read this page. Check the URL and its accessibility.");
      // Tavily Extract does not provide a separate page title.
      return pageOutput("tavily", url, null, page.raw_content);
    }),
  ],
  testConnection: async (apiKey, signal) => {
    const data = await tavilyRequest(apiKey, "usage", undefined, signal);
    if (typeof object(data.key).usage !== "number")
      throw new PluginRequestError("Tavily did not confirm the connected account.");
    return "Connected to Tavily.";
  },
};
