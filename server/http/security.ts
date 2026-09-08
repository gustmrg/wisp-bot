import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors.js";

export interface HttpSecurityOptions {
  publicOrigin?: string;
  allowedOrigins?: string[];
  allowedHosts: Set<string>;
}
export function checkOrigin(request: IncomingMessage, response: ServerResponse, options: HttpSecurityOptions): void {
  const host = request.headers.host;
  if (!host || !options.allowedHosts.has(host.toLowerCase()))
    throw new HttpError(403, "forbidden", "The HTTP host is not allowed.");
  const origin = request.headers.origin;
  if (origin) {
    const own = options.publicOrigin ?? `http://${host}`;
    if (origin !== own && !options.allowedOrigins?.includes(origin))
      throw new HttpError(403, "forbidden", "The request origin is not allowed.");
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  }
  const nativeBootstrap = Boolean(
    origin &&
      options.allowedOrigins?.includes(origin) &&
      (request.method === "OPTIONS" ||
        ["/api/v1/auth/pair", "/api/v1/auth/refresh"].includes((request.url ?? "").split("?")[0]!)),
  );
  if (request.headers["sec-fetch-site"] === "cross-site" && !request.headers.authorization && !nativeBootstrap)
    throw new HttpError(403, "forbidden", "Cross-site requests are not allowed.");
}
export function cookies(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0) result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}
export function checkCsrf(request: IncomingMessage, expected: string): void {
  const supplied = request.headers["x-wisp-csrf"];
  if (
    typeof supplied !== "string" ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    throw new HttpError(403, "forbidden", "The session verification header is missing or invalid.");
}
export async function jsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    throw new HttpError(400, "invalid_request", "Use application/json for this request.");
  if (Number(request.headers["content-length"] ?? 0) > maxBytes)
    throw new HttpError(413, "payload_too_large", "The request exceeds the payload limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new HttpError(413, "payload_too_large", "The request exceeds the payload limit.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_request", "The JSON request is invalid.");
  }
}
