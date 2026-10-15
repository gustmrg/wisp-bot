import type { PluginAdapter } from "../plugin-types.js";
import { object, output, PluginRequestError, requestJson, textField } from "./shared.js";
import { searchInput, webSearchTool } from "./web.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

async function searchWeb(apiKey: string, raw: unknown, signal?: AbortSignal): Promise<string> {
  const { query, count } = searchInput(raw);
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("text_decorations", "false");
  const payload = await requestJson(
    "Brave Search",
    url.toString(),
    { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
    signal,
  );
  const results = object(payload.web).results;
  if (!payload.query && !Array.isArray(results))
    throw new PluginRequestError("Brave Search returned an invalid result.");
  return output({
    provider: "brave",
    query,
    results: (Array.isArray(results) ? results : []).slice(0, count).map((value) => {
      const result = object(value);
      return {
        title: textField(result.title, 200),
        url: textField(result.url, 1_000),
        snippet: textField(result.description, 1_500),
      };
    }),
    moreResultsAvailable: object(payload.query).more_results_available === true,
  });
}

export const webSearch: PluginAdapter = {
  id: "web-search",
  tools: [webSearchTool(searchWeb)],
  testConnection: async (apiKey, signal) => {
    await searchWeb(apiKey, { query: "Brave Search", count: 1 }, signal);
    return "Connected to Brave Search.";
  },
};
