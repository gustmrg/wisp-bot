import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  isAllowedExternalUrl,
  isAllowedPermission,
  isAllowedRendererUrl,
  resolveRendererTarget,
  TRUSTED_DEVELOPMENT_ORIGIN,
} from "../../electron/security-policy.js";

const renderer = path.resolve("dist/index.html");

describe("Electron renderer security policy", () => {
  it("uses bundled content in packaged mode even when an environment URL exists", () => {
    expect(resolveRendererTarget(true, `${TRUSTED_DEVELOPMENT_ORIGIN}/`, renderer)).toMatchObject({
      kind: "production",
      filePath: renderer,
    });
  });

  it.each([
    "http://localhost:5173/",
    "http://127.0.0.1:5174/",
    "http://127.0.0.1.example:5173/",
    "http://user@127.0.0.1:5173/",
    "not a url",
  ])("rejects an untrusted development URL: %s", (url) => {
    expect(resolveRendererTarget(false, url, renderer).kind).toBe("production");
  });

  it("accepts only the exact development entry URL", () => {
    expect(resolveRendererTarget(false, `${TRUSTED_DEVELOPMENT_ORIGIN}/`, renderer)).toEqual({
      kind: "development",
      url: `${TRUSTED_DEVELOPMENT_ORIGIN}/`,
      origin: TRUSTED_DEVELOPMENT_ORIGIN,
    });
  });

  it("allows same-origin development navigation and only the production renderer file", () => {
    const development = resolveRendererTarget(false, `${TRUSTED_DEVELOPMENT_ORIGIN}/`, renderer);
    const production = resolveRendererTarget(true, undefined, renderer);
    expect(isAllowedRendererUrl(`${TRUSTED_DEVELOPMENT_ORIGIN}/settings`, development)).toBe(true);
    expect(isAllowedRendererUrl("http://127.0.0.1.example:5173/", development)).toBe(false);
    expect(isAllowedRendererUrl(pathToFileURL(renderer).href, production)).toBe(true);
    expect(isAllowedRendererUrl(pathToFileURL(path.resolve("dist/other.html")).href, production)).toBe(false);
    expect(isAllowedRendererUrl("https://example.com/", production)).toBe(false);
  });

  it.each(["https://example.com/path?q=1", "http://example.com/", "mailto:someone@example.com"])(
    "allows web and mail links to open externally: %s",
    (url) => {
      expect(isAllowedExternalUrl(url)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "smb://attacker.example/share",
    "javascript:alert(1)",
    "vscode://extension/install",
    "ms-msdt:/id",
    "https://bank.example@evil.example/",
    "not a url",
    "",
  ])("refuses to hand other URLs to the OS: %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it("defaults permissions to deny with narrow clipboard and microphone exceptions", () => {
    const target = resolveRendererTarget(false, `${TRUSTED_DEVELOPMENT_ORIGIN}/`, renderer);
    expect(isAllowedPermission("clipboard-sanitized-write", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target)).toBe(true);
    expect(isAllowedPermission("clipboard-sanitized-write", "https://example.com/", true, target)).toBe(false);
    expect(isAllowedPermission("clipboard-sanitized-write", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, false, target)).toBe(
      false,
    );
    expect(isAllowedPermission("media", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target)).toBe(false);
    expect(isAllowedPermission("media", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target, ["audio"])).toBe(true);
    expect(isAllowedPermission("media", "https://example.com/", true, target, ["audio"])).toBe(false);
    expect(isAllowedPermission("media", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, false, target, ["audio"])).toBe(false);
    expect(isAllowedPermission("media", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target, ["video"])).toBe(false);
    expect(isAllowedPermission("media", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target, ["audio", "video"])).toBe(
      false,
    );
    expect(isAllowedPermission("geolocation", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target)).toBe(false);
    expect(isAllowedPermission("notifications", `${TRUSTED_DEVELOPMENT_ORIGIN}/`, true, target)).toBe(false);
  });

  it("keeps production CSP free of wildcards and development-only websocket access", () => {
    const production = contentSecurityPolicy(false);
    expect(production).toContain("default-src 'none'");
    expect(production).toContain("script-src 'self'");
    expect(production).not.toContain("unsafe-eval");
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("ws:");
    expect(production).not.toMatch(/(?:default|script)-src \*/);
    const development = contentSecurityPolicy(true);
    expect(development).toContain("script-src 'self' 'unsafe-inline'");
    expect(development).toContain("ws://127.0.0.1:5173");
  });
});
