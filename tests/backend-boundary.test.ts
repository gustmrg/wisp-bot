import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const backendDirectory = path.join(__dirname, "../backend");

describe("backend boundary", () => {
  it("never imports Electron or desktop-only modules", async () => {
    const files = (await readdir(backendDirectory)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(backendDirectory, file), "utf8");
      for (const [, specifier] of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        if (/^electron(-updater)?$|^\.\.\/electron\//.test(specifier ?? "")) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
