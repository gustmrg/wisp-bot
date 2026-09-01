import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

const packageMetadata = createRequire(import.meta.url)("./package.json") as PackageMetadata;

export default defineConfig({
  base: "./",
  define: {
    __APP_PACKAGE_NAME__: JSON.stringify(packageMetadata.name),
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
