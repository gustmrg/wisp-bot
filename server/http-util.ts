import type { IncomingMessage, ServerResponse } from "node:http";

import { decodeRemoteJson, encodeRemoteJson } from "../shared/remote-codec.js";
import { HttpError, invalidRequest } from "./errors.js";

/** Reads and decodes a JSON body, failing early once it exceeds `limit` bytes. */
export async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "payload_too_large", "The request is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "payload_too_large", "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return decodeRemoteJson(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidRequest("The request body is not valid JSON.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = encodeRemoteJson(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

export function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, {
    ok: false,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  });
}
