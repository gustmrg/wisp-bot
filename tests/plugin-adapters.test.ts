import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_TOOL_NAMES, getToolMetadata } from "../shared/tool-catalog.js";
import { PLUGIN_ADAPTERS } from "../electron/backend/plugin-adapters.js";
import { sanitizeBackendError } from "../electron/backend/backend-error.js";

const KEY = "private-api-key-must-not-appear";
const tools = PLUGIN_ADAPTERS.flatMap((adapter) => adapter.tools);
const tool = (name: string) => {
  const result = tools.find((item) => item.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
};
const fakeIssue = {
  id: "issue-id",
  identifier: "ENG-123",
  title: "Fix sign-in",
  url: "https://linear.app/example/issue/ENG-123/fix-sign-in",
  priority: 2,
  updatedAt: "2026-09-07T12:00:00.000Z",
  team: { id: "team-id", name: "Engineering", key: "ENG" },
  state: { id: "state-id", name: "In Progress", type: "started" },
  assignee: null,
};

function mockJson(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof mockJson>) {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("built-in plugin adapters", () => {
  it("registers every plugin tool in the conversation agent discovery catalog", () => {
    for (const adapter of PLUGIN_ADAPTERS) {
      for (const spec of adapter.tools) {
        const metadata = getToolMetadata(spec.name);
        expect(metadata?.pluginIds ?? [metadata?.pluginId]).toContain(adapter.id);
        expect(BUILTIN_TOOL_NAMES).not.toContain(spec.name);
      }
    }
  });

  it("searches only the fixed Brave endpoint with its API key header and bounded result count", async () => {
    const fetchMock = mockJson({
      query: { more_results_available: true },
      web: {
        results: [{ title: "Example", url: "https://example.com", description: "Snippet" }, { title: "Ignored" }],
      },
    });
    const result = JSON.parse(await tool("web_search").execute(KEY, { query: "a query & more", count: 1 }));
    const url = new URL(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("a query & more");
    expect(url.searchParams.get("count")).toBe("1");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "X-Subscription-Token": KEY },
      redirect: "error",
    });
    expect(result).toEqual({
      provider: "brave",
      query: "a query & more",
      results: [{ title: "Example", url: "https://example.com", snippet: "Snippet" }],
      moreResultsAvailable: true,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    ["web_search", { query: "" }],
    ["web_search", { query: "x".repeat(501) }],
    ["web_search", { query: "a ".repeat(76) }],
    ["web_search", { query: "x", count: 11 }],
    ["web_search", { query: "x", count: 1.2 }],
    ["web_search", { query: "x", url: "https://evil.example" }],
    ["linear_search_issues", { query: "x", limit: 21 }],
    ["linear_search_issues", { cursor: "x".repeat(501) }],
    ["linear_get_issue", { id: "" }],
    ["linear_list_teams", null],
    ["linear_list_statuses", {}],
    ["linear_create_issue", { teamId: "team", title: "" }],
    ["linear_create_issue", { teamId: "team", title: "Title", priority: 5 }],
    ["linear_update_issue", { id: "ENG-123" }],
    ["linear_update_issue", { id: "ENG-123", title: "x", query: "mutation { arbitrary }" }],
    ["linear_update_issue", { id: "ENG-123", description: "x".repeat(20_001) }],
  ])("validates %s arguments before any request (%j)", async (name, args) => {
    const fetchMock = mockJson({});
    await expect(tool(name).execute(KEY, args)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes Linear search text, filters and cursor as GraphQL variables", async () => {
    const fetchMock = mockJson({
      data: { issues: { nodes: [fakeIssue], pageInfo: { hasNextPage: true, endCursor: "next" } } },
    });
    const query = 'quote " } mutation Unsafe { x }';
    const result = JSON.parse(
      await tool("linear_search_issues").execute(KEY, {
        query,
        teamId: "team",
        stateId: "state",
        cursor: "previous",
        limit: 3,
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: KEY },
      redirect: "error",
    });
    const body = requestBody(fetchMock);
    expect(body.query).not.toContain(query);
    expect(body.query).toContain("issues(filter: $filter, first: $first, after: $after");
    expect(body.variables).toEqual({
      filter: {
        or: [{ title: { containsIgnoreCase: query } }, { description: { containsIgnoreCase: query } }],
        team: { id: { eq: "team" } },
        state: { id: { eq: "state" } },
      },
      first: 3,
      after: "previous",
    });
    expect(result.nodes[0].identifier).toBe("ENG-123");
    expect(result.pageInfo).toEqual({ hasNextPage: true, endCursor: "next" });
  });

  it("gets issue identifiers directly and bounds long descriptions", async () => {
    const fetchMock = mockJson({ data: { issue: { ...fakeIssue, description: "x".repeat(40_000) } } });
    const result = JSON.parse(await tool("linear_get_issue").execute(KEY, { id: "ENG-123" }));
    expect(requestBody(fetchMock).variables).toEqual({ id: "ENG-123" });
    expect(result.description).toContain("[truncated]");
    expect(result.description.length).toBeLessThan(20_100);
  });

  it("exposes team and status discovery with continuation cursors", async () => {
    const fetchMock = mockJson({
      data: {
        teams: { nodes: [fakeIssue.team], pageInfo: { hasNextPage: true, endCursor: "team-next" } },
        workflowStates: {
          nodes: [{ ...fakeIssue.state, team: fakeIssue.team }],
          pageInfo: { hasNextPage: false, endCursor: "state-end" },
        },
      },
    });
    expect(JSON.parse(await tool("linear_list_teams").execute(KEY, { limit: 1, cursor: "team-prev" }))).toMatchObject({
      nodes: [fakeIssue.team],
      pageInfo: { endCursor: "team-next" },
    });
    expect(requestBody(fetchMock).variables).toEqual({ first: 1, after: "team-prev" });
    fetchMock.mockClear();
    expect(JSON.parse(await tool("linear_list_statuses").execute(KEY, { teamId: "team-id", limit: 2 }))).toMatchObject({
      nodes: [{ id: "state-id" }],
      pageInfo: { hasNextPage: false },
    });
    expect(requestBody(fetchMock).variables).toEqual({ filter: { team: { id: { eq: "team-id" } } }, first: 2 });
  });

  it("creates issues with only the validated fields and produces an approval summary", async () => {
    const fetchMock = mockJson({ data: { issueCreate: { success: true, issue: fakeIssue } } });
    const args = { teamId: "team-id", title: "Fix sign-in", description: "Details", priority: 2, stateId: "state-id" };
    expect(tool("linear_create_issue").access).toBe("write");
    expect(tool("linear_create_issue").summarize(args)).toContain("team-id");
    expect(tool("linear_create_issue").summarize(args)).toContain("Fix sign-in");
    expect(JSON.parse(await tool("linear_create_issue").execute(KEY, args))).toMatchObject({
      success: true,
      issue: { identifier: "ENG-123" },
    });
    expect(requestBody(fetchMock).variables).toEqual({ input: args });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates only supplied fields, including clearing a description and priority", async () => {
    const fetchMock = mockJson({ data: { issueUpdate: { success: true, issue: fakeIssue } } });
    const args = { id: "ENG-123", description: "", priority: 0, stateId: "state-id" };
    await tool("linear_update_issue").execute(KEY, args);
    expect(requestBody(fetchMock).variables).toEqual({
      id: "ENG-123",
      input: { description: "", priority: 0, stateId: "state-id" },
    });
    expect(tool("linear_update_issue").summarize(args)).toBe("Update issue ENG-123 (description, stateId, priority)");
  });

  it.each([401, 403, 429, 500])("never exposes the provider error body on HTTP %s", async (status) => {
    mockJson({ error: `provider secret ${KEY}` }, status);
    const error = await tool("web_search")
      .execute(KEY, { query: "example" })
      .catch((value: unknown) => value);
    expect(String(error)).toContain(`HTTP ${status}`);
    expect(String(error)).not.toContain(KEY);
  });

  it("rejects partial GraphQL errors without disclosing their content", async () => {
    mockJson({ data: { issue: fakeIssue }, errors: [{ message: `provider diagnostic ${KEY}` }] });
    const error = await tool("linear_get_issue")
      .execute(KEY, { id: "ENG-123" })
      .catch((value: unknown) => value);
    expect(String(error)).toContain("Linear could not complete");
    expect(String(error)).not.toContain(KEY);
  });

  it("sanitizes fetch errors and does not retry uncertain writes", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`failed Authorization: ${KEY}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = await tool("linear_create_issue")
      .execute(KEY, { teamId: "team", title: "New" })
      .catch((value: unknown) => value);
    expect(String(error)).not.toContain(KEY);
    expect(String(error)).toContain("Check Linear before retrying");
    expect(sanitizeBackendError(error)).toMatchObject({
      code: "internal_error",
      message: expect.stringContaining("the change may have been applied"),
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves safe validation and authentication errors through backend serialization", async () => {
    mockJson({ message: KEY }, 401);
    const inputError = await tool("linear_get_issue")
      .execute(KEY, { id: "" })
      .catch((error: unknown) => error);
    expect(sanitizeBackendError(inputError)).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Invalid id"),
    });
    const authError = await tool("web_search")
      .execute(KEY, { query: "example" })
      .catch((error: unknown) => error);
    expect(sanitizeBackendError(authError)).toMatchObject({
      code: "invalid_configuration",
      message: expect.stringContaining("Check the API key"),
    });
  });

  it("rejects a failed mutation payload instead of claiming success", async () => {
    mockJson({ data: { issueUpdate: { success: false, issue: fakeIssue } } });
    await expect(tool("linear_update_issue").execute(KEY, { id: "ENG-123", title: "Title" })).rejects.toThrow(
      "did not confirm",
    );
  });

  it("aborts in-flight requests without exposing the caller's abort reason", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error(KEY)), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = tool("web_search").execute(KEY, { query: "example" }, controller.signal);
    controller.abort(new Error(KEY));
    await expect(pending).rejects.toThrow("request cancelled");
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  it("does not dispatch an already-cancelled request", async () => {
    const fetchMock = mockJson({});
    const controller = new AbortController();
    controller.abort(KEY);
    await expect(tool("linear_list_teams").execute(KEY, {}, controller.signal)).rejects.toThrow("request cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out an unresponsive provider", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error(KEY)), { once: true });
          }),
      ),
    );
    const pending = expect(tool("web_search").execute(KEY, { query: "example" })).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(25_001);
    await pending;
  });

  it("bounds streamed provider responses even without a content-length header", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    await expect(tool("web_search").execute(KEY, { query: "example" })).rejects.toThrow("response is too large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a stalled response body when the request times out", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))),
    );
    const pending = expect(tool("web_search").execute(KEY, { query: "example" })).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(25_001);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds oversized result output and clearly marks truncation", async () => {
    mockJson({
      data: {
        issues: {
          nodes: Array.from({ length: 20 }, () => ({
            ...fakeIssue,
            title: "x".repeat(500),
            url: `https://example.com/${"x".repeat(1_000)}`,
          })),
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      },
    });
    const result = await tool("linear_search_issues").execute(KEY, { limit: 20 });
    expect(result.length).toBeLessThanOrEqual(32_000);
    expect(result).toContain("truncated");
    const parsed = JSON.parse(result);
    expect(parsed.nodes).toHaveLength(20);
    expect(parsed.pageInfo).toEqual({ hasNextPage: true, endCursor: "next" });
  });

  it("tests both connections using minimal read-only requests", async () => {
    const fetchMock = mockJson({ query: {}, data: { viewer: { id: "viewer-id" } } });
    const web = PLUGIN_ADAPTERS.find((item) => item.id === "web-search");
    const linear = PLUGIN_ADAPTERS.find((item) => item.id === "linear");
    await expect(web?.testConnection(KEY)).resolves.toBe("Connected to Brave Search.");
    await expect(linear?.testConnection(KEY)).resolves.toBe("Connected to Linear.");
    const linearBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(linearBody.query).toBe("query WispConnection { viewer { id } }");
    expect(linearBody.query).not.toContain("mutation");
  });
});

describe("Firecrawl", () => {
  const search = PLUGIN_ADAPTERS.find(({ id }) => id === "firecrawl")!.tools.find(({ name }) => name === "web_search")!;

  it("searches with the shared contract and returns sources without scraping results", async () => {
    const fetchMock = mockJson({
      success: true,
      data: { web: [{ title: "Example", url: "https://example.com", description: "Snippet" }, { title: "Ignored" }] },
    });
    const result = JSON.parse(await search.execute(KEY, { query: "a query", count: 1 }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/search");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      redirect: "error",
    });
    expect(requestBody(fetchMock)).toEqual({ query: "a query", limit: 1, sources: ["web"], timeout: 20_000 });
    expect(result).toEqual({
      provider: "firecrawl",
      query: "a query",
      results: [{ title: "Example", url: "https://example.com", snippet: "Snippet" }],
      moreResultsAvailable: null,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    { query: "" },
    { query: "x".repeat(501) },
    { query: "a ".repeat(76) },
    { query: "example", count: 11 },
    { query: "example", count: 1.5 },
    { query: "example", scrapeOptions: {} },
  ])("rejects invalid search arguments %j before fetching", async (input) => {
    const fetchMock = mockJson({});
    await expect(search.execute(KEY, input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles empty searches and rejects malformed search responses", async () => {
    mockJson({ success: true, data: { web: [] } });
    expect(JSON.parse(await search.execute(KEY, { query: "example" })).results).toEqual([]);
    mockJson({ success: true, data: {} });
    await expect(search.execute(KEY, { query: "example" })).rejects.toThrow("invalid search result");
  });

  it("reads bounded Markdown through the fixed API endpoint", async () => {
    const fetchMock = mockJson({
      success: true,
      data: { markdown: "x".repeat(30_000), metadata: { title: "Example" } },
    });
    const result = JSON.parse(await tool("web_read").execute(KEY, { url: "https://example.com" }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: `Bearer ${KEY}` },
      redirect: "error",
    });
    expect(requestBody(fetchMock)).toEqual({
      url: "https://example.com/",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 20_000,
    });
    expect(result).toMatchObject({ url: "https://example.com", title: "Example", truncated: true });
    expect(result.markdown.length).toBeLessThan(21_000);
    expect(tool("web_read").access).toBe("read");
  });

  it.each(["file:///etc/passwd", "https://user:secret@example.com", "not a URL"])(
    "rejects invalid URL %s before fetching",
    async (url) => {
      const fetchMock = mockJson({});
      await expect(tool("web_read").execute(KEY, { url })).rejects.toMatchObject({ code: "invalid_request" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("checks credentials without scraping a page", async () => {
    const fetchMock = mockJson({ success: true, data: { remainingCredits: 0 } });
    await expect(PLUGIN_ADAPTERS.find(({ id }) => id === "firecrawl")!.testConnection(KEY)).resolves.toBe(
      "Connected to Firecrawl.",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("does not expose provider error payloads", async () => {
    mockJson({ success: false, error: KEY });
    await expect(tool("web_read").execute(KEY, { url: "https://example.com" })).rejects.toThrow(
      "Firecrawl could not complete the request.",
    );
  });
});
