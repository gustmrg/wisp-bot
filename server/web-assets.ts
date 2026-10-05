import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

import { HttpError } from "./errors.js";

/**
 * The browser app's policy: like the desktop renderer's, plus what a web app
 * served by the Wisp server needs (its own API, manifest, and service worker).
 */
export function webContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/**
 * Serves the browser app from `root`. Unknown paths get `index.html`, so the
 * app handles its own routes; nothing outside `root` is ever read.
 */
export async function serveWeb(response: ServerResponse, root: string, pathname: string, head: boolean): Promise<void> {
  const base = await realpath(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_request", "The path is invalid.");
  }
  if (decoded.includes("\0")) throw new HttpError(400, "invalid_request", "The path is invalid.");
  let file = path.resolve(base, `.${decoded}`);
  if (!(await isFileWithin(base, file))) file = path.join(base, "index.html");
  const resolved = await realpath(file).catch(() => {
    throw new HttpError(404, "not_found", "Not found.");
  });
  if (!(await isFileWithin(base, resolved))) throw new HttpError(404, "not_found", "Not found.");
  const extension = path.extname(resolved);
  const info = await stat(resolved);
  const relative = path.relative(base, resolved).split(path.sep).join("/");
  response.writeHead(200, {
    "Content-Type": TYPES[extension] ?? "application/octet-stream",
    "Content-Length": info.size,
    // Built assets carry a content hash; everything else must be revalidated so updates show up.
    "Cache-Control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(extension === ".html" ? { "Content-Security-Policy": webContentSecurityPolicy() } : {}),
    ...(relative === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
  });
  if (head) {
    response.end();
    return;
  }
  createReadStream(resolved).pipe(response);
}

async function isFileWithin(base: string, file: string): Promise<boolean> {
  const relative = path.relative(base, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
