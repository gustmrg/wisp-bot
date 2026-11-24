import { WispBackendError } from "./backend-error.js";
import { MAX_TOOL_SNAPSHOT_TOOLS } from "./mcp-validation.js";

/**
 * Structural surface of the pieces of the official MCP TypeScript SDK
 * (@modelcontextprotocol/client, pinned 2.x) used by the bridge. Keeping the
 * surface structural allows tests to drive the bridge with in-memory servers.
 */
export interface McpSdkTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface McpSdkClient {
  connect(transport: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: McpSdkTool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  onclose?: (() => void) | undefined;
}

export interface McpSdkModuleShape {
  Client: new (
    info: { name: string; version: string },
    options?: {
      capabilities?: Record<string, never>;
      listChanged?: { tools?: { onChanged: (error: Error | null, tools: McpSdkTool[] | undefined) => void } };
    },
  ) => McpSdkClient;
  StreamableHTTPClientTransport: new (
    url: URL,
    options?: { requestInit?: { headers?: Record<string, string> }; authProvider?: unknown; fetch?: unknown },
  ) => unknown;
}

export type McpConnectionAuth = (
  | { mode: "none" }
  | { mode: "header"; headerName: string; headerValue: string }
  | { mode: "oauth"; provider: unknown }
) & {
  /** Non-secret headers sent with every request; the authentication header wins on a clash. */
  extraHeaders?: Readonly<Record<string, string>>;
};

export interface McpConnectionOptions {
  /** The application version advertised to the server during initialization. */
  clientVersion?: string;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** Maximum tools accepted from one server; discovery fails beyond this. */
  maxTools?: number;
  sdk?: McpSdkModuleShape;
  fetch?: unknown;
  /** Invoked when the SDK reports a tool-list change or the connection drops. */
  onToolsChanged?: (tools: McpSdkTool[] | undefined) => void;
  onClosed?: () => void;
  /** Observes a connect that failed for a reason other than a needed sign-in, for the server's log. */
  onConnectFailed?: (failure: { endpoint: string; reason: string }) => void;
}

export type McpConnectionStatus = "idle" | "connected" | "needs_sign_in" | "unavailable";

const CLIENT_NAME = "wisp-bot";

/**
 * One lazily-connected remote MCP client. Bridges Streamable HTTP transport,
 * bounded discovery, tool dispatch with cancellation, and result conversion.
 * A failed server never throws into unrelated Wisps' tool sessions: callers
 * translate failures into per-tool errors.
 */
export class McpConnection {
  private readonly options: Required<Pick<McpConnectionOptions, "connectTimeoutMs" | "toolTimeoutMs" | "maxTools">> &
    McpConnectionOptions;
  private client: McpSdkClient | null = null;
  private status: McpConnectionStatus = "idle";

  constructor(options: McpConnectionOptions = {}) {
    this.options = {
      // Some servers take most of a minute to answer initialize; Atlassian's
      // sends only keep-alives for 40-50 seconds before its first result.
      connectTimeoutMs: 90_000,
      toolTimeoutMs: 120_000,
      maxTools: MAX_TOOL_SNAPSHOT_TOOLS,
      ...options,
    };
  }

  get connectionStatus(): McpConnectionStatus {
    return this.status;
  }

  /**
   * Connects and initializes the session. With OAuth, a missing or expired
   * authorization is refreshed non-interactively first; when interactive
   * sign-in would be required, returns "needs_sign_in" instead of opening a
   * browser unless `allowInteractiveSignIn` is set. The transport's internal
   * 401 handling always runs non-interactively, so the sign-in below is the
   * only code path that can open a browser — exactly one window per sign-in.
   */
  async connect(
    endpoint: string,
    auth: McpConnectionAuth,
    options: { allowInteractiveSignIn?: boolean; signal?: AbortSignal } = {},
  ): Promise<"connected" | "needs_sign_in"> {
    await this.close();
    const sdk = this.options.sdk ?? (await loadMcpSdk());
    const oauthProvider =
      auth.mode === "oauth" ? (auth.provider as { setInteractiveSignIn?: (allowed: boolean) => void }) : undefined;
    // Left off across every attempt: the SDK transport also runs auth on 401
    // during connect, and an interactive provider would open a second browser
    // window alongside the one refreshOrSignIn opens below.
    oauthProvider?.setInteractiveSignIn?.(false);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client: McpSdkClient | null = null;
      try {
        client = new sdk.Client(
          { name: CLIENT_NAME, version: this.options.clientVersion ?? "0.0.0" },
          {
            // Advertise no sampling, elicitation, or roots capabilities; the
            // SDK fails unsupported interaction requests clearly.
            capabilities: {},
            listChanged: {
              tools: {
                onChanged: (error, tools) => {
                  if (error) return;
                  this.options.onToolsChanged?.(tools);
                },
              },
            },
          },
        );
        client.onclose = () => {
          if (this.client === client) {
            this.client = null;
            this.status = "unavailable";
            this.options.onClosed?.();
          }
        };
        const headers = {
          ...auth.extraHeaders,
          ...(auth.mode === "header" ? { [auth.headerName]: auth.headerValue } : {}),
        };
        const transport = new sdk.StreamableHTTPClientTransport(new URL(endpoint), {
          ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
          ...(auth.mode === "oauth" ? { authProvider: auth.provider } : {}),
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        await withTimeout(
          client.connect(transport as never, { signal: options.signal }),
          this.options.connectTimeoutMs,
          "connect",
        );
        this.client = client;
        this.status = "connected";
        return "connected";
      } catch (error) {
        // Never leak a half-open transport between attempts. A refused
        // interactive redirect surfaces either as McpSignInRequiredError or,
        // when the transport wraps it, as UnauthorizedError.
        await client?.close().catch(() => undefined);
        const authorizationNeeded = isSignInRequired(error) || isUnauthorized(error);
        if (authorizationNeeded && auth.mode === "oauth" && attempt === 0) {
          const refreshed = await refreshOrSignIn(sdk, auth, endpoint, options.allowInteractiveSignIn === true);
          if (refreshed === "needs_sign_in") {
            this.status = "needs_sign_in";
            return "needs_sign_in";
          }
          continue;
        }
        if (authorizationNeeded) {
          this.status = "needs_sign_in";
          return "needs_sign_in";
        }
        this.status = "unavailable";
        const failure = toConnectionError(error);
        this.options.onConnectFailed?.({ endpoint, reason: describeFailure(error, failure) });
        throw failure;
      }
    }
    throw new WispBackendError("internal_error", "The MCP server could not be connected.", true);
  }

  /** Discovers tools; the SDK aggregates all pages with its own page cap. */
  async listTools(signal?: AbortSignal): Promise<McpSdkTool[]> {
    const client = this.assertConnected();
    try {
      const result = await client.listTools();
      signal?.throwIfAborted();
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      if (tools.length > this.options.maxTools) {
        throw new WispBackendError(
          "invalid_configuration",
          `This server exposes ${tools.length} tools; the limit is ${this.options.maxTools}.`,
        );
      }
      return tools;
    } catch (error) {
      throw toConnectionError(error);
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const client = this.assertConnected();
    try {
      return await client.callTool(
        { name, arguments: args },
        {
          timeout: options.timeoutMs ?? this.options.toolTimeoutMs,
          signal: options.signal,
        },
      );
    } catch (error) {
      if (isSessionExpired(error)) {
        // The server dropped our session (typically a restart). Closing lets
        // the pool open a fresh one; the request was refused before it ran.
        await this.close();
        throw new McpSessionExpiredError();
      }
      throw toToolError(error, options.signal);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    this.status = "idle";
    await client.close().catch(() => undefined);
  }

  private assertConnected(): McpSdkClient {
    if (!this.client || this.status !== "connected") {
      throw new WispBackendError("tool_blocked", "The MCP server is not connected.");
    }
    return this.client;
  }
}

/** Bounded conversion of an MCP tool result into text for the model. */
export interface ConvertedToolResult {
  text: string;
  isError: boolean;
}

const MAX_RESULT_TEXT_CHARACTERS = 64_000;
const MAX_STRUCTURED_RESULT_CHARACTERS = 32_000;

export function convertMcpToolResult(result: unknown): ConvertedToolResult {
  if (!result || typeof result !== "object") {
    return { text: "[The tool returned no content.]", isError: false };
  }
  const record = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const parts: string[] = [];
  let unsupported = 0;
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      const type = (block as { type?: unknown }).type;
      if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      } else if (type === "image" || type === "audio") {
        unsupported += 1;
      } else if (type === "resource") {
        const text = embeddedResourceText(block);
        if (text === undefined) unsupported += 1;
        else parts.push(text);
      } else if (type === "resource_link") {
        // Resource links are never fetched automatically.
        unsupported += 1;
      }
    }
  }
  if (unsupported > 0) {
    parts.push(
      `[This result included ${unsupported} unsupported content block${unsupported === 1 ? "" : "s"} (images, audio, or resources), which this app does not display.]`,
    );
  }
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    try {
      const json = JSON.stringify(record.structuredContent);
      parts.push(
        `\n[Structured result]\n${json.length <= MAX_STRUCTURED_RESULT_CHARACTERS ? json : `${json.slice(0, MAX_STRUCTURED_RESULT_CHARACTERS)}…[truncated]`}`,
      );
    } catch {
      parts.push("\n[Structured result could not be displayed.]");
    }
  }
  const text = truncateUtf8(parts.join("\n").trim() || "[The tool returned no content.]", MAX_RESULT_TEXT_CHARACTERS);
  return { text, isError: record.isError === true };
}

/**
 * The text of a resource embedded in a result, headed by its URI, or nothing
 * for a binary one. Servers such as GitHub's return a file's contents this
 * way, beside a text block that only names the file; the contents already
 * came with the result, so nothing is fetched.
 */
function embeddedResourceText(block: object): string | undefined {
  const resource = (block as { resource?: unknown }).resource;
  if (!resource || typeof resource !== "object") return undefined;
  const { text, uri } = resource as { text?: unknown; uri?: unknown };
  if (typeof text !== "string") return undefined;
  return typeof uri === "string" && uri.length > 0 ? `[Resource ${uri}]\n${text}` : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpTransportError("timeout", `The MCP server did not ${action} in time.`, `${action} timeout`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function refreshOrSignIn(
  sdk: McpSdkModuleShape,
  auth: Extract<McpConnectionAuth, { mode: "oauth" }>,
  endpoint: string,
  allowInteractiveSignIn: boolean,
): Promise<"refreshed" | "signed_in" | "needs_sign_in"> {
  type AuthFn = (provider: unknown, options: Record<string, unknown>) => Promise<string>;
  const authFn = (sdk as unknown as { auth?: AuthFn }).auth;
  if (!authFn) return "needs_sign_in";
  // Interactive sign-in is enabled only inside this function so the connect
  // attempts around it can never open a browser; a non-interactive provider
  // throws McpSignInRequiredError instead, treated as "needs sign-in".
  const provider = auth.provider as { setInteractiveSignIn?: (allowed: boolean) => void };
  provider?.setInteractiveSignIn?.(allowInteractiveSignIn === true);
  try {
    const result = await authFn(auth.provider, { serverUrl: endpoint }).catch((error) =>
      isSignInRequired(error) || !allowInteractiveSignIn ? "needs_sign_in" : "error",
    );
    if (result === "AUTHORIZED") return "refreshed";
    if (result !== "REDIRECT" || !allowInteractiveSignIn) return "needs_sign_in";
    const waiting = auth.provider as { waitForCallback?: () => Promise<URLSearchParams> };
    if (!waiting.waitForCallback) return "needs_sign_in";
    const callback = await waiting.waitForCallback().catch(() => undefined);
    if (!callback) return "needs_sign_in";
    const code = callback.get("code");
    if (!code) return "needs_sign_in";
    // RFC 9207: servers advertising issuer responses require the iss parameter
    // on the code exchange for mix-up defense.
    const iss = callback.get("iss");
    const exchange = await authFn(auth.provider, {
      serverUrl: endpoint,
      authorizationCode: code,
      ...(iss ? { iss } : {}),
    }).catch(() => "error");
    return exchange === "AUTHORIZED" ? "signed_in" : "needs_sign_in";
  } finally {
    provider?.setInteractiveSignIn?.(false);
  }
}

/**
 * The server no longer knows this connection's session. The request never ran,
 * so repeating it on a new session is safe.
 */
export class McpSessionExpiredError extends WispBackendError {
  constructor() {
    super("internal_error", "The MCP session expired.", true);
    this.name = "McpSessionExpiredError";
  }
}

/**
 * How a request failed on its way to or from the server: `unreachable` never
 * got an answer (network, DNS, TLS), `rejected` got an HTTP error, and
 * `timeout` got no answer in time from a server that may still be working.
 */
export type McpTransportFailureKind = "unreachable" | "rejected" | "timeout";

/** A transport failure, with a message a person can act on and a secret-free detail for the log. */
export class McpTransportError extends WispBackendError {
  constructor(
    readonly kind: McpTransportFailureKind,
    message: string,
    /** The error code or HTTP status behind the message, such as `UND_ERR_CONNECT_TIMEOUT` or `HTTP 403`. */
    readonly detail: string,
  ) {
    super("internal_error", message, true);
    this.name = "McpTransportError";
  }
}

const NETWORK_FAILURES: ReadonlyArray<{ codes: RegExp; kind: McpTransportFailureKind; message: string }> = [
  {
    codes: /^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT)$/,
    kind: "unreachable",
    message:
      "The MCP server did not accept the connection in time. A firewall, VPN, or Tailscale rule may be blocking the way to it.",
  },
  {
    codes: /^(ENETUNREACH|EHOSTUNREACH)$/,
    kind: "unreachable",
    message: "The MCP server could not be reached: there is no network route to it.",
  },
  {
    codes: /^(ENOTFOUND|EAI_AGAIN)$/,
    kind: "unreachable",
    message: "The MCP server's address could not be found. Check the address and this computer's DNS.",
  },
  {
    codes: /^ECONNREFUSED$/,
    kind: "unreachable",
    message: "The MCP server refused the connection. It may be stopped or listening on another port.",
  },
  {
    codes: /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/,
    kind: "unreachable",
    message: "The connection to the MCP server closed before it answered.",
  },
  {
    codes: /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/,
    kind: "unreachable",
    message: "The MCP server's TLS certificate was not accepted.",
  },
  {
    codes: /^(UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|REQUEST_TIMEOUT)$/,
    kind: "timeout",
    message: "The MCP server did not answer in time.",
  },
];

/**
 * Recognizes why a request failed from the error fetch or the SDK raised.
 * Fetch wraps the network error in `cause`, sometimes as an AggregateError
 * of one error per address tried. Response bodies and headers are never
 * read, so neither the message nor the detail can carry a credential.
 */
export function transportFailure(error: unknown): McpTransportError | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return httpFailure(status);
  if (error instanceof Error && error.name === "UnauthorizedError") return httpFailure(401);
  for (const code of errorCodes(error)) {
    const known = NETWORK_FAILURES.find(({ codes }) => codes.test(code));
    if (known) return new McpTransportError(known.kind, known.message, code);
  }
  return undefined;
}

function httpFailure(status: number): McpTransportError {
  const message =
    status === 401
      ? "The MCP server did not accept the credentials (HTTP 401). Check the connection's authentication."
      : status === 403
        ? "The MCP server denied access (HTTP 403)."
        : `The MCP server answered with an error (HTTP ${status}).`;
  return new McpTransportError("rejected", message, `HTTP ${status}`);
}

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 4) return [];
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [
    ...(typeof code === "string" ? [code] : []),
    ...errorCodes(cause, depth + 1),
    ...(Array.isArray(errors) ? errors.flatMap((inner) => errorCodes(inner, depth + 1)) : []),
  ];
}

function isSessionExpired(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status } = error as { status?: unknown };
  return status === 404 && /session not found/i.test(error.message);
}

function isSignInRequired(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "McpSignInRequiredError" || /sign-in is required/i.test(error.message))
  );
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && (error.name === "UnauthorizedError" || /unauthorized|401/.test(error.message));
}

function toConnectionError(error: unknown): WispBackendError {
  if (error instanceof WispBackendError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new WispBackendError("aborted", "The MCP request was cancelled.");
  }
  return (
    transportFailure(error) ??
    new WispBackendError("internal_error", "The MCP server could not complete the request.", true)
  );
}

/** The cause behind a connection error, for the log; an unrecognized one reaches the user only as the generic message. */
function describeFailure(error: unknown, failure: WispBackendError): string {
  if (failure instanceof McpTransportError) return `${failure.message} (${failure.detail})`;
  if (error === failure || !(error instanceof Error)) return failure.message;
  return `${failure.message} (${error.name}: ${error.message})`;
}

function toToolError(error: unknown, signal: AbortSignal | undefined): WispBackendError {
  if (error instanceof WispBackendError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new WispBackendError("aborted", "The MCP request was cancelled.");
  }
  return transportFailure(error) ?? new WispBackendError("internal_error", "The MCP tool call failed.", true);
}

function truncateUtf8(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}…[truncated]`;
}

let sdkModule: McpSdkModuleShape | undefined;

async function loadMcpSdk(): Promise<McpSdkModuleShape> {
  if (!sdkModule) {
    sdkModule = (await import("@modelcontextprotocol/client")) as unknown as McpSdkModuleShape;
  }
  return sdkModule;
}
