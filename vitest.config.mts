import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

const packageMetadata = createRequire(import.meta.url)("./package.json") as PackageMetadata;

export default defineConfig({
  define: {
    __APP_PACKAGE_NAME__: JSON.stringify(packageMetadata.name),
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
