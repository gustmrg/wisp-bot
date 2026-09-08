import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

/**
 * Node's fetch normalizes Host to the local tunnel port. Pin the actual backend
 * Host here while keeping arbitrary URLs and headers outside the renderer.
 */
export function createTunnelFetch(endpoint: string, hostHeader: string): typeof fetch {
  const origin = new URL(endpoint);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !/^127\.0\.0\.1:\d{1,5}$/.test(hostHeader))
    throw new Error("Invalid SSH tunnel endpoint.");
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin.origin || url.username || url.password)
      throw new Error("The SSH transport only accesses its bound loopback endpoint.");
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      throw new Error("The SSH transport expects a JSON request body.");
    const body = init?.body as string | null | undefined;
    const headers = Object.fromEntries(new Headers(init?.headers));
    headers.host = hostHeader;
    headers["accept-encoding"] = "identity";
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("The connection was cancelled.", "AbortError"));
        return;
      }
      const request = httpRequest(url, { method: init?.method ?? "GET", headers }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          init?.redirect === "error"
        ) {
          response.destroy();
          reject(new Error("SSH API redirects are not allowed."));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const status = response.statusCode ?? 502;
        response.once("close", () => signal?.removeEventListener("abort", abort));
        resolve(
          new Response(
            [204, 205, 304].includes(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      });
      const abort = (): void => {
        request.destroy(new DOMException("The connection was cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      request.once("error", (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      request.end(body ?? undefined);
    });
  };
}
