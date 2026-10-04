import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TRUSTED_DEVELOPMENT_ORIGIN = "http://127.0.0.1:5173";
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
// shell.openExternal hands URLs to the OS, where file:, smb:, and custom app
// protocols can launch local handlers. Only web and mail links may leave the app.
const EXTERNAL_URL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export type RendererTarget =
  | { kind: "development"; url: string; origin: string }
  | { kind: "production"; filePath: string; url: string };

export function resolveRendererTarget(
  isPackaged: boolean,
  environmentUrl: string | undefined,
  productionFilePath: string,
): RendererTarget {
  if (!isPackaged && environmentUrl) {
    try {
      const parsed = new URL(environmentUrl);
      if (
        !parsed.username &&
        !parsed.password &&
        parsed.origin === TRUSTED_DEVELOPMENT_ORIGIN &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash
      ) {
        return { kind: "development", url: `${TRUSTED_DEVELOPMENT_ORIGIN}/`, origin: TRUSTED_DEVELOPMENT_ORIGIN };
      }
    } catch {
      // Invalid environment values fall back to bundled content.
    }
  }
  const filePath = path.resolve(productionFilePath);
  return { kind: "production", filePath, url: pathToFileURL(filePath).href };
}

export function isAllowedRendererUrl(value: string, target: RendererTarget): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (target.kind === "development") return parsed.origin === target.origin;
    if (parsed.protocol !== "file:" || parsed.host) return false;
    return path.resolve(fileURLToPath(parsed)) === target.filePath;
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    // Embedded credentials enable look-alike links such as https://bank.example@evil.example/.
    return EXTERNAL_URL_PROTOCOLS.has(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * `mediaTypes` lists what a "media" request captures. Voice input needs the
 * microphone only, so camera and screen capture stay denied.
 */
export function isAllowedPermission(
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
  target: RendererTarget,
  mediaTypes: ReadonlyArray<string> = [],
): boolean {
  const allowed =
    permission === "media"
      ? mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio")
      : ALLOWED_PERMISSIONS.has(permission);
  return isMainFrame && allowed && isAllowedRendererUrl(requestingUrl, target);
}

export function contentSecurityPolicy(development: boolean): string {
  const script = development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const style = development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'; style-src-attr 'unsafe-inline'";
  const connect = development
    ? `connect-src 'self' ws://${new URL(TRUSTED_DEVELOPMENT_ORIGIN).host}`
    : "connect-src 'none'";
  return [
    "default-src 'none'",
    script,
    style,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    connect,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
