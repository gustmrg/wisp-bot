import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
});
