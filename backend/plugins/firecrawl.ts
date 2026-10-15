import type { PluginAdapter } from "../plugin-types.js";
import { type Fields, object, output, PluginRequestError, requestJson, textField } from "./shared.js";
import { pageOutput, readInput, searchInput, webReadTool, webSearchTool } from "./web.js";

async function firecrawlRequest(apiKey: string, path: string, body?: Fields, signal?: AbortSignal) {
  const payload = await requestJson(
    "Firecrawl",
    `https://api.firecrawl.dev/v2/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    signal,
  );
  if (payload.success !== true || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new PluginRequestError("Firecrawl could not complete the request.");
  }
  return object(payload.data);
}

export const firecrawl: PluginAdapter = {
  id: "firecrawl",
  tools: [
    webSearchTool(async (apiKey, raw, signal) => {
      const { query, count } = searchInput(raw);
      const data = await firecrawlRequest(
        apiKey,
        "search",
        { query, limit: count, sources: ["web"], timeout: 20_000 },
        signal,
      );
      if (!Array.isArray(data.web)) throw new PluginRequestError("Firecrawl returned an invalid search result.");
      return output({
        provider: "firecrawl",
        query,
        results: data.web.slice(0, count).map((value) => {
          const result = object(value);
          return {
            title: textField(result.title, 200),
            url: textField(result.url, 1_000),
            snippet: textField(result.description, 1_500),
          };
        }),
        // Firecrawl does not report whether another page of results exists.
        moreResultsAvailable: null,
      });
    }),
    webReadTool(async (apiKey, raw, signal) => {
      const { url, normalizedUrl } = readInput(raw);
      const data = await firecrawlRequest(
        apiKey,
        "scrape",
        {
          url: normalizedUrl,
          formats: ["markdown"],
          onlyMainContent: true,
          timeout: 20_000,
        },
        signal,
      );
      if (typeof data.markdown !== "string") throw new PluginRequestError("Firecrawl returned an invalid page.");
      const metadata = object(data.metadata);
      return pageOutput("firecrawl", url, metadata.title, data.markdown);
    }),
  ],
  testConnection: async (apiKey, signal) => {
    const data = await firecrawlRequest(apiKey, "team/credit-usage", undefined, signal);
    if (typeof data.remainingCredits !== "number")
      throw new PluginRequestError("Firecrawl did not confirm the connected account.");
    return "Connected to Firecrawl.";
  },
};
