import { readFileSync } from "node:fs";
import path from "node:path";

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

describe("isSupportedNode", () => {
  it("requires Node.js 22.19", () => {
    for (const version of ["22.19.0", "v22.19.1", "22.20.0", "24.1.0"])
      expect(isSupportedNode(version), version).toBe(true);
    for (const version of ["22.18.9", "20.19.0", "18.20.4"]) expect(isSupportedNode(version), version).toBe(false);
  });
});
