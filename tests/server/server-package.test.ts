import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { transform } from "esbuild";
import { describe, expect, it } from "vitest";

import { WISP_SERVER_PACKAGE } from "../../shared/server-package.js";
import { isSupportedNode } from "../../server/node-version.js";

const root = path.join(__dirname, "../..");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

describe("server package manifest", () => {
  it("declares the runtime dependencies at the versions the app uses", () => {
    const app = read("package.json");
    const server = read("server/package.json");
    for (const [name, version] of Object.entries(server.dependencies)) {
      expect(app.dependencies[name], name).toBe(version);
    }
    expect(server.engines.node).toBe(app.engines.node);
  });

  it("publishes under the name the app and the setup command install", () => {
    const server = read("server/package.json");
    expect(server.name).toBe(WISP_SERVER_PACKAGE);
    expect(server.private).toBeUndefined();
    expect(server.bin).toEqual({ "wisp-server": "server/cli.js", wispctl: "server/cli.js" });
    expect(server.publishConfig).toEqual({ access: "public", provenance: true });
  });
});

describe("server package README", () => {
  it("documents the setup command and each of its options", () => {
    const readme = readFileSync(path.join(root, "server/README.md"), "utf8");
    expect(readme).toContain(`npx ${WISP_SERVER_PACKAGE} setup`);
    const help = readFileSync(path.join(root, "server/cli.ts"), "utf8").split("Options of setup:")[1]!;
    const options = [...help.matchAll(/^ {2}(--[a-z-]+)/gm)].map((match) => match[1]!);
    expect(options.length).toBeGreaterThan(3);
    // The desktop app's own option is not for people.
    for (const option of options.filter((name) => name !== "--until-stdin-closes")) {
      expect(readme, option).toContain(`\`${option}`);
    }
    expect(readFileSync(path.join(root, "scripts/package-server.mjs"), "utf8")).toContain('"README.md"');
  });
});

describe("isSupportedNode", () => {
  it("requires Node.js 22.19", () => {
    for (const version of ["22.19.0", "v22.19.1", "22.20.0", "24.1.0"])
      expect(isSupportedNode(version), version).toBe(true);
    for (const version of ["22.18.9", "20.19.0", "18.20.4"]) expect(isSupportedNode(version), version).toBe(false);
  });
});

describe("node-version", () => {
  it("hides only the SQLite experimental warning", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-node-version-"));
    try {
      const { code } = await transform(readFileSync(path.join(root, "server/node-version.ts"), "utf8"), {
        loader: "ts",
        format: "cjs",
      });
      const file = path.join(directory, "node-version.cjs");
      writeFileSync(file, code);
      const { stderr } = spawnSync(
        process.execPath,
        [
          "-e",
          `require(${JSON.stringify(file)});
          process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
          process.emitWarning("Something else is experimental", "ExperimentalWarning");`,
        ],
        { encoding: "utf8" },
      );
      expect(stderr).not.toContain("SQLite");
      expect(stderr).toContain("Something else is experimental");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
