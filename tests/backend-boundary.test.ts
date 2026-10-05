import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { recursive: true });
  return entries.filter((file) => file.endsWith(".ts")).map((file) => path.join(directory, file));
}

async function importsOf(directories: string[]): Promise<Array<[string, string]>> {
  const found: Array<[string, string]> = [];
  for (const file of (await Promise.all(directories.map(sources))).flat()) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) found.push([file, specifier ?? ""]);
  }
  return found;
}

describe("backend and server boundary", () => {
  it("never imports Electron or desktop code", async () => {
    const imports = await importsOf(["backend", "server", "shared"]);
    expect(imports.length).toBeGreaterThan(0);
    const offenders = imports.filter(([, specifier]) =>
      /^electron(-updater)?$|\/electron\/|^\.\.\/src\//.test(specifier),
    );
    expect(offenders).toEqual([]);
  });

  it("only uses packages the server package installs", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "server/package.json"), "utf8"));
    const serverDependencies = Object.keys(manifest.dependencies as object);
    const external = (await importsOf(["backend", "server", "shared"])).filter(
      ([, specifier]) => !specifier.startsWith(".") && !specifier.startsWith("node:"),
    );
    const missing = external.filter(([, specifier]) => {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      return !serverDependencies.includes(name) && !builtinModules.includes(name);
    });
    expect(missing).toEqual([]);
  });
});
