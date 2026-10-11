import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
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
    {
      name: "wisp-web-service-worker",
      apply: "build",
      async writeBundle(options, bundle) {
        // The service worker installs this build's files up front, so a cold
        // open with a slow or missing network has every file the app needs.
        const assets = Object.keys(bundle)
          .filter((fileName) => fileName.startsWith("assets/"))
          .sort()
          .map((fileName) => `/${fileName}`);
        const hash = createHash("sha256");
        for (const fileName of Object.keys(bundle).sort()) {
          const output = bundle[fileName]!;
          hash.update(fileName).update(output.type === "chunk" ? output.code : output.source);
        }
        const file = path.join(options.dir!, "sw.js");
        const source = await readFile(file, "utf8");
        const built = source
          .replace('const VERSION = "dev";', `const VERSION = ${JSON.stringify(hash.digest("hex").slice(0, 12))};`)
          .replace("const ASSETS = [];", `const ASSETS = ${JSON.stringify(assets)};`);
        if (!built.includes('const ASSETS = ["'))
          throw new Error("sw.js no longer has the placeholders the build fills in.");
        await writeFile(file, built);
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
