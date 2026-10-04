import { describe, expect, it, vi } from "vitest";

import {
  McpConnection,
  convertMcpToolResult,
  type McpSdkClient,
  type McpSdkModuleShape,
  type McpSdkTool,
} from "../electron/backend/mcp-bridge.js";
import { McpSignInRequiredError } from "../electron/backend/mcp-oauth.js";

const TOOLS: McpSdkTool[] = [
  { name: "search", description: "Search things", inputSchema: { type: "object" } },
  { name: "create", description: "Create things", inputSchema: { type: "object" } },
];

function fakeSdk(
  options: {
    connect?: (client: FakeClient) => Promise<void> | void;
    auth?: (provider: unknown, opts: Record<string, unknown>) => Promise<string>;
    listTools?: () => Promise<{ tools: McpSdkTool[] }>;
    tools?: McpSdkTool[];
  } = {},
): { sdk: McpSdkModuleShape; clients: FakeClient[]; transports: Array<Record<string, unknown>> } {
  const clients: FakeClient[] = [];
  const transports: Array<Record<string, unknown>> = [];
  const sdk: McpSdkModuleShape = {
    Client: function (this: unknown, info: unknown, clientOptions: unknown) {
      const client = new FakeClient(info, clientOptions, options);
      clients.push(client);
      return client;
    } as unknown as McpSdkModuleShape["Client"],
    StreamableHTTPClientTransport: function (this: unknown, url: URL, transportOptions: unknown) {
      const transport = { url: url.toString(), options: transportOptions };
      transports.push(transport);
      return transport;
    } as unknown as McpSdkModuleShape["StreamableHTTPClientTransport"],
  };
  if (options.auth) {
    (sdk as unknown as { auth: typeof options.auth }).auth = options.auth;
  }
  class FakeClient implements McpSdkClient {
    onclose: (() => void) | undefined;
    constructor(
      readonly info: unknown,
      _clientOptions: unknown,
      clientConfig: typeof options,
    ) {}
    connect = vi.fn(async () => {
      if (options.connect) await options.connect(this);
    });
    close = vi.fn(async () => undefined);
    listTools = options.listTools ?? vi.fn(async () => ({ tools: options.tools ?? TOOLS }));
    callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  }
  return { sdk, clients, transports };
}

describe("McpConnection", () => {
  it("connects with header authentication and lists tools", async () => {
    const { sdk, clients, transports } = fakeSdk();
    const onClosed = vi.fn();
    const connection = new McpConnection({ sdk, onClosed, clientVersion: "1.2.3" });
    const outcome = await connection.connect("https://example.com/mcp", {
      mode: "header",
      headerName: "Authorization",
      headerValue: "Bearer sekrit",
    });
    expect(outcome).toBe("connected");
    expect(clients[0]?.info).toEqual({ name: "wisp-bot", version: "1.2.3" });
    expect(transports[0]?.url).toBe("https://example.com/mcp");
    const transportOptions = transports[0]?.options as { requestInit?: { headers?: Record<string, string> } };
    expect(transportOptions.requestInit?.headers).toEqual({ Authorization: "Bearer sekrit" });
    const tools = await connection.listTools();
    expect(tools.map(({ name }) => name)).toEqual(["search", "create"]);
    expect(clients[0]?.connect).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("camps discovery at the configured tool limit", async () => {
    const oversized = Array.from({ length: 65 }, (_, index) => ({
      name: `tool-${index}`,
      inputSchema: { type: "object" },
    }));
    const { sdk } = fakeSdk({ tools: oversized });
    const connection = new McpConnection({ sdk, maxTools: 64 });
    await connection.connect("https://example.com/mcp", { mode: "none" });
    await expect(connection.listTools()).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("returns needs_sign_in for an unauthorized oauth server without opening a browser", async () => {
    const auth = vi.fn(async () => "REDIRECT");
    const { sdk } = fakeSdk({
      connect: () => {
        const error = new Error("Unauthorized");
        error.name = "UnauthorizedError";
        throw error;
      },
      auth,
    });
    const connection = new McpConnection({ sdk });
    const outcome = await connection.connect("https://example.com/mcp", { mode: "oauth", provider: {} });
    expect(outcome).toBe("needs_sign_in");
    // One non-interactive refresh attempt; no interactive callback awaited.
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("refreshes authorization non-interactively and retries the connection", async () => {
    const auth = vi.fn(async () => "AUTHORIZED");
    let attempts = 0;
    const { sdk, clients } = fakeSdk({
      connect: () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("token expired (401)");
          throw error;
        }
      },
      auth,
    });
    const connection = new McpConnection({ sdk });
    const outcome = await connection.connect("https://example.com/mcp", { mode: "oauth", provider: {} });
    expect(outcome).toBe("connected");
    expect(auth).toHaveBeenCalledTimes(1);
    // The retry builds a fresh client/transport; the failed one is closed, not leaked.
    expect(clients).toHaveLength(2);
    expect(clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(clients[1]!.connect).toHaveBeenCalledTimes(1);
  });

  it("marks the connection unavailable when the server closes it", async () => {
    const { sdk, clients } = fakeSdk();
    const onClosed = vi.fn();
    const connection = new McpConnection({ sdk, onClosed });
    await connection.connect("https://example.com/mcp", { mode: "none" });
    clients[0]!.onclose?.();
    expect(connection.connectionStatus).toBe("unavailable");
    expect(onClosed).toHaveBeenCalledTimes(1);
    // Calls on a closed connection fail instead of silently reconnecting.
    await expect(connection.callTool("search", {})).rejects.toMatchObject({ code: "tool_blocked" });
  });

  it("dispatches calls with a timeout and surfaces aborts", async () => {
    const { sdk, clients } = fakeSdk();
    const connection = new McpConnection({ sdk, toolTimeoutMs: 5_000 });
    await connection.connect("https://example.com/mcp", { mode: "none" });
    const controller = new AbortController();
    clients[0]!.callTool = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(connection.callTool("search", { q: 1 }, { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

function fakeOAuthProvider() {
  return {
    interactive: false,
    redirectedTo: undefined as string | undefined,
    redirectCount: 0,
    setInteractiveSignIn(allowed: boolean) {
      this.interactive = allowed;
    },
    async redirectToAuthorization(url: URL) {
      // Mirrors the real provider: refuses background redirects.
      if (!this.interactive) throw new McpSignInRequiredError();
      this.redirectedTo = url.toString();
      this.redirectCount += 1;
    },
    async waitForCallback() {
      return new URLSearchParams({ code: "the-code", iss: "https://auth.example.com" });
    },
  };
}

describe("McpConnection OAuth", () => {
  function unauthorizedSdk(
    authLog: Array<Record<string, unknown>>,
    provider: ReturnType<typeof fakeOAuthProvider>,
    succeedAfter = Number.POSITIVE_INFINITY,
  ) {
    let attempts = 0;
    return fakeSdk({
      connect: () => {
        attempts += 1;
        if (attempts > succeedAfter) return;
        const error = new Error("token required");
        error.name = "UnauthorizedError";
        throw error;
      },
      auth: async (ignoredProvider: unknown, options: Record<string, unknown>) => {
        authLog.push(options);
        if (options.authorizationCode) return "AUTHORIZED";
        // The real SDK invokes redirectToAuthorization before returning REDIRECT.
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      },
    }).sdk;
  }

  it("never opens a browser for background OAuth connections", async () => {
    const provider = fakeOAuthProvider();
    const authLog: Array<Record<string, unknown>> = [];
    const connection = new McpConnection({ sdk: unauthorizedSdk(authLog, provider) });
    const outcome = await connection.connect("https://example.com/mcp", { mode: "oauth", provider });
    expect(outcome).toBe("needs_sign_in");
    expect(provider.redirectedTo).toBeUndefined();
    expect(provider.interactive).toBe(false);
    expect(authLog).toHaveLength(1);
  });

  it("runs the interactive flow for explicit sign-ins and forwards the callback issuer", async () => {
    const provider = fakeOAuthProvider();
    const authLog: Array<Record<string, unknown>> = [];
    const connection = new McpConnection({ sdk: unauthorizedSdk(authLog, provider, 1) });
    const outcome = await connection.connect(
      "https://example.com/mcp",
      { mode: "oauth", provider },
      {
        allowInteractiveSignIn: true,
      },
    );
    expect(outcome).toBe("connected");
    expect(provider.redirectedTo).toBe("https://auth.example.com/authorize");
    expect(provider.redirectCount).toBe(1);
    // The code exchange carries the authorization code and the RFC 9207 issuer.
    expect(authLog[1]).toMatchObject({
      authorizationCode: "the-code",
      iss: "https://auth.example.com",
    });
  });

  it("opens the browser exactly once even when the transport runs its own 401 auth", async () => {
    const provider = fakeOAuthProvider();
    const authLog: Array<Record<string, unknown>> = [];
    let connects = 0;
    const { sdk } = fakeSdk({
      connect: async () => {
        // Mirrors the SDK transport: on 401 it invokes auth() itself, whose
        // redirectToAuthorization would open a window, then throws.
        connects += 1;
        if (connects > 1) return;
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        const error = new Error("token required");
        error.name = "UnauthorizedError";
        throw error;
      },
      auth: async (ignoredProvider: unknown, options: Record<string, unknown>) => {
        authLog.push(options);
        if (options.authorizationCode) return "AUTHORIZED";
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      },
    });
    const connection = new McpConnection({ sdk });
    const outcome = await connection.connect(
      "https://example.com/mcp",
      { mode: "oauth", provider },
      {
        allowInteractiveSignIn: true,
      },
    );
    expect(outcome).toBe("connected");
    // The transport's own attempt runs non-interactively and is refused; only
    // the explicit sign-in redirect opens a browser window.
    expect(provider.redirectCount).toBe(1);
    expect(provider.interactive).toBe(false);
    expect(authLog).toHaveLength(2);
  });
});

describe("convertMcpToolResult", () => {
  it("passes text through and flags server-reported errors", () => {
    const ok = convertMcpToolResult({ content: [{ type: "text", text: "hello" }] });
    expect(ok).toEqual({ text: "hello", isError: false });

    const failed = convertMcpToolResult({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("boom");
  });

  it("reports unsupported content blocks instead of dropping them silently", () => {
    const converted = convertMcpToolResult({
      content: [
        { type: "text", text: "see attachment" },
        { type: "image", data: "xxx", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///etc/passwd" },
      ],
    });
    expect(converted.text).toContain("see attachment");
    expect(converted.text).toContain("unsupported content block");
    expect(converted.text).not.toContain("etc/passwd");
  });

  it("appends bounded structured results and truncates oversized text", () => {
    const structured = convertMcpToolResult({
      content: [],
      structuredContent: { rows: [1, 2, 3] },
    });
    expect(structured.text).toContain("[Structured result]");
    expect(structured.text).toContain("[1,2,3]");

    const oversized = convertMcpToolResult({ content: [{ type: "text", text: "x".repeat(70_000) }] });
    expect(oversized.text.length).toBeLessThanOrEqual(64_000 + "[…[truncated]".length);
    expect(oversized.text.endsWith("[truncated]")).toBe(true);
  });
});
