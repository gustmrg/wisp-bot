import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_PROVIDER } from "../shared/claude-code.js";
import { providerKind } from "../shared/provider-kinds.js";

const root = path.join(__dirname, "..");

/** Where a provider's kind is decided from its ID, or where a runtime's own code knows its provider. */
const KIND_DECIDED_IN = ["shared/provider-kinds.ts", "backend/claude-code/"];

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { recursive: true });
  return entries
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(directory, file));
}

describe("providerKind", () => {
  it("runs Claude Code on its own runtime, with its own sign-in and output limit", () => {
    expect(providerKind(CLAUDE_CODE_PROVIDER)).toEqual({
      runtime: "claude-code",
      credential: "external",
      outputLimit: "runtime",
    });
  });

  it("runs every other provider on Pi with a key or sign-in Wisp keeps", () => {
    for (const providerId of ["openai", "openrouter", "anthropic", "claude"]) {
      expect(providerKind(providerId)).toEqual({ runtime: "pi", credential: "required", outputLimit: "configurable" });
    }
  });

  it("is the only place that compares a provider ID with Claude Code's", async () => {
    const files = (await Promise.all(["backend", "client", "electron", "server", "shared", "src"].map(sources))).flat();
    expect(files.length).toBeGreaterThan(0);
    const comparison = /[!=]==?\s*(?:CLAUDE_CODE_PROVIDER\b|["']claude-code["'])|CLAUDE_CODE_PROVIDER\s*[!=]==?/;
    const offenders: string[] = [];
    for (const file of files) {
      if (KIND_DECIDED_IN.some((allowed) => file.startsWith(allowed))) continue;
      const source = await readFile(path.join(root, file), "utf8");
      source.split("\n").forEach((line, index) => {
        if (comparison.test(line) && !/runtime\s*[!=]==?\s*["']claude-code["']/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
