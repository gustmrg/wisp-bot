import { CONTAINER_WORKSPACE } from "./execution.js";

const MIB = 1024 * 1024;
/** Largest file shown in a reply or a preview; a larger one is only downloaded. */
export const MEDIA_PREVIEW_LIMIT_BYTES = 16 * MIB;
/** Largest Markdown file shown formatted; a larger one is shown as plain text. */
export const MARKDOWN_PREVIEW_LIMIT_BYTES = 2 * MIB;
/** Largest file a device downloads from a reply. */
export const MEDIA_DOWNLOAD_LIMIT_BYTES = 512 * MIB;

/**
 * `GET /api/v1/media?conversationId=<id>&messageId=<id>&path=<path>[&maxBytes=<n>]`
 * answers a workspace file a Wisp's message refers to, as raw bytes; a refusal
 * is a `BackendResult` in JSON.
 */
export const MEDIA_PATH = "/media";

/** A workspace file shown in a Wisp's message, asked for by the message that refers to it. */
export interface ReadConversationMediaRequest {
  conversationId: string;
  /** The Wisp's message that refers to the file: only files a Wisp showed in the conversation are served. */
  messageId: string;
  /** As the message wrote it. */
  path: string;
  /** Refused with `too_large` when the file is larger. */
  maxBytes?: number;
}

export interface ConversationMedia {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type MediaKind = "image" | "audio" | "video" | "html" | "markdown" | "file";

const MEDIA_TYPES: Record<string, { kind: MediaKind; mimeType: string }> = {
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".bmp": { kind: "image", mimeType: "image/bmp" },
  ".ico": { kind: "image", mimeType: "image/x-icon" },
  // An SVG can carry scripts; shown through <img>, they never run.
  ".svg": { kind: "image", mimeType: "image/svg+xml" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
  ".oga": { kind: "audio", mimeType: "audio/ogg" },
  ".opus": { kind: "audio", mimeType: "audio/ogg" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".m4v": { kind: "video", mimeType: "video/mp4" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".ogv": { kind: "video", mimeType: "video/ogg" },
  ".html": { kind: "html", mimeType: "text/html" },
  ".htm": { kind: "html", mimeType: "text/html" },
  ".md": { kind: "markdown", mimeType: "text/markdown" },
  ".markdown": { kind: "markdown", mimeType: "text/markdown" },
  ".pdf": { kind: "file", mimeType: "application/pdf" },
  ".txt": { kind: "file", mimeType: "text/plain" },
  ".csv": { kind: "file", mimeType: "text/csv" },
  ".json": { kind: "file", mimeType: "application/json" },
  ".zip": { kind: "file", mimeType: "application/zip" },
};

function extensionOf(path: string): string {
  const name = mediaName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** How a file is shown: by its extension, as the file's contents are not known before it is fetched. */
export function mediaKind(path: string): MediaKind {
  return MEDIA_TYPES[extensionOf(path)]?.kind ?? "file";
}

export function mediaMimeType(path: string): string {
  return MEDIA_TYPES[extensionOf(path)]?.mimeType ?? "application/octet-stream";
}

/** The file's name, the last part of its path. */
export function mediaName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** A path in the Wisp's workspace, as opposed to a web address or an inline image. */
export function isWorkspaceMediaPath(source: string): boolean {
  const value = source.trim();
  return value.length > 0 && !value.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

/**
 * One spelling for a workspace path, so the path a message wrote and the one
 * asked for match: percent-escapes decoded (Markdown encodes spaces), `./`
 * removed, and the container's `/workspace/` read as the workspace itself.
 */
export function normalizeMediaPath(source: string): string {
  let value = source.trim();
  try {
    value = decodeURI(value);
  } catch {
    // Kept as written: a literal % that is not an escape.
  }
  if (value === CONTAINER_WORKSPACE) return ".";
  if (value.startsWith(`${CONTAINER_WORKSPACE}/`)) value = value.slice(CONTAINER_WORKSPACE.length + 1);
  while (value.startsWith("./")) value = value.slice(2);
  return value.replace(/\/{2,}/g, "/");
}

// Code is left as written: a tag or image shown as an example is not shown as a file.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;
const MEDIA_TAG = /<media\s+src\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\/?>(?:\s*<\/media>)?/gi;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

function mapProse(text: string, map: (prose: string) => string): string {
  return text
    .split(CODE)
    .map((part, index) => (index % 2 === 0 ? map(part) : part))
    .join("");
}

/**
 * A Wisp's reply with each `<media src="…" />` written as a Markdown image,
 * which the reply's renderer shows as an image, a player or a file card.
 */
export function withMediaImages(text: string): string {
  if (!/<media\b/i.test(text)) return text;
  return mapProse(text, (prose) =>
    prose.replace(MEDIA_TAG, (_tag, double: string | undefined, single: string | undefined) => {
      const source = (double ?? single ?? "").trim();
      return source ? `![](<${source.replace(/[<>\n]/g, "")}>)` : "";
    }),
  );
}

/** The workspace paths a Wisp's message shows, normalized, from its media tags and Markdown images. */
export function referencedMediaPaths(text: string): ReadonlySet<string> {
  const paths = new Set<string>();
  mapProse(withMediaImages(text), (prose) => {
    for (const match of prose.matchAll(MARKDOWN_IMAGE)) {
      const source = match[1] ?? match[2] ?? "";
      if (isWorkspaceMediaPath(source)) paths.add(normalizeMediaPath(source));
    }
    return prose;
  });
  return paths;
}

/**
 * The policy of the page an HTML file is previewed in (`media-preview.html`):
 * the file's own scripts and styles run, and web images, styles, fonts and
 * media load, but scripts cannot make requests, forms cannot be sent and no
 * other frame or worker starts. Other workspace files the document names are
 * never served there. The page also runs in a sandboxed frame with an opaque
 * origin, so it cannot read the app's storage or cookies.
 */
export const MEDIA_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:",
  "style-src 'unsafe-inline' https: http: data:",
  "img-src https: http: data: blob:",
  "font-src https: http: data:",
  "media-src https: http: data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");
