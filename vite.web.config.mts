import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { webContentSecurityPolicy } from "./server/web-assets.js";

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

const packageMetadata = createRequire(import.meta.url)("./package.json") as PackageMetadata;
const repository = fileURLToPath(new URL(".", import.meta.url));

/**
 * The browser app: the same renderer as the desktop app, with `window.wisp`
 * talking to the Wisp server that serves it. The server serves `dist-web`.
 */
export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/",
  define: {
    __APP_PACKAGE_NAME__: JSON.stringify(packageMetadata.name),
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
  },
  plugins: [
    {
      name: "wisp-web-content-security-policy",
      transformIndexHtml(html) {
        // Vite's development server injects inline scripts; the built app needs none.
        const policy = webContentSecurityPolicy();
        return html.replace(
          "__WISP_CSP__",
          command === "serve" ? policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : policy,
        );
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: { allow: [repository] },
  },
}));
