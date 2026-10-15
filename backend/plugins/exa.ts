import type { PluginAdapter } from "../plugin-types.js";
import { type Fields, object, output, PluginRequestError, requestJson, textField } from "./shared.js";
import { pageOutput, readInput, searchInput, webReadTool, webSearchTool } from "./web.js";

async function exaRequest(apiKey: string, path: "search" | "contents", body: Fields, signal?: AbortSignal) {
  return requestJson(
    "Exa",
    `https://api.exa.ai/${path}`,
    {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
}

export const exa: PluginAdapter = {
  id: "exa",
  tools: [
    webSearchTool(async (apiKey, raw, signal) => {
      const { query, count } = searchInput(raw);
      const data = await exaRequest(
        apiKey,
        "search",
        { query, numResults: count, type: "auto", contents: { highlights: { maxCharacters: 1_500 } } },
        signal,
      );
      if (!Array.isArray(data.results)) throw new PluginRequestError("Exa returned an invalid search result.");
      return output({
        provider: "exa",
        query,
        results: data.results.slice(0, count).map((value) => {
          const result = object(value);
          const highlights = Array.isArray(result.highlights)
            ? result.highlights.filter((item): item is string => typeof item === "string").join("\n")
            : undefined;
          return {
            title: textField(result.title, 200),
            url: textField(result.url, 1_000),
            snippet: textField(highlights, 1_500),
          };
        }),
        moreResultsAvailable: null,
      });
    }),
    webReadTool(async (apiKey, raw, signal) => {
      const { url, normalizedUrl } = readInput(raw);
      const data = await exaRequest(
        apiKey,
        "contents",
        { urls: [normalizedUrl], text: { maxCharacters: 20_001, includeHtmlTags: false }, livecrawlTimeout: 20_000 },
        signal,
      );
      const page = object(Array.isArray(data.results) && data.results.length === 1 ? data.results[0] : undefined);
      if (typeof page.text !== "string")
        throw new PluginRequestError("Exa could not read this page. Check the URL and its accessibility.");
      return pageOutput("exa", url, page.title, page.text);
    }),
  ],
  testConnection: async (apiKey, signal) => {
    const data = await exaRequest(apiKey, "search", { query: "Exa", numResults: 1, type: "auto" }, signal);
    if (!Array.isArray(data.results)) throw new PluginRequestError("Exa did not confirm the connection.");
    return "Connected to Exa.";
  },
};
