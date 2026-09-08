import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const metadata = createRequire(import.meta.url)("./package.json") as { name: string; version: string };
export default defineConfig(({ command, mode }) => {
  const mobile = mode === "mobile";
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self'${command === "serve" ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src 'self'${mobile ? " https:" : command === "serve" ? " ws://127.0.0.1:5174 ws://localhost:5174" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
  return {
    base: "/",
    publicDir: "web/public",
    define: {
      __APP_PACKAGE_NAME__: JSON.stringify(metadata.name),
      __APP_VERSION__: JSON.stringify(metadata.version),
      __WISP_MOBILE__: JSON.stringify(mobile),
    },
    plugins: [
      {
        name: "wisp-web-entry",
        transformIndexHtml: {
          order: "pre",
          handler(html) {
            return html.includes("/src/main.tsx")
              ? readFileSync(new URL("./web/index.html", import.meta.url), "utf8").replace("__WISP_WEB_CSP__", csp)
              : html.replace("__WISP_WEB_CSP__", csp);
          },
        },
      },
      react(),
      tailwindcss(),
      {
        name: "wisp-static-service-worker",
        generateBundle(_options, bundle) {
          if (mobile) return;
          const assets = [
            "/index.html",
            "/favicon.svg",
            "/icon-192.png",
            "/icon-512.png",
            "/manifest.webmanifest",
            ...Object.keys(bundle)
              .filter((file) => file.startsWith("assets/") && !file.endsWith(".map"))
              .map((file) => `/${file}`),
          ];
          const hash = createHash("sha256").update(JSON.stringify(assets)).digest("hex").slice(0, 16);
          const source = readFileSync(new URL("./web/service-worker.js", import.meta.url), "utf8")
            .replace("__WISP_CACHE_NAME__", JSON.stringify(`wisp-assets-${hash}`))
            .replace("__WISP_STATIC_ASSETS__", JSON.stringify(assets));
          this.emitFile({ type: "asset", fileName: "sw.js", source });
        },
      },
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    build: { outDir: mobile ? "dist-mobile" : "dist-web", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" },
    },
  };
});
