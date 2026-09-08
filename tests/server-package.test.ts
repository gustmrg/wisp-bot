import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("packages only deployment templates, never local deployment keys or configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-package-"));
  try {
    const fixtures = [
      "dist-server/server/main.js",
      "dist-web/index.html",
      "server/package.json",
      "server/package-lock.json",
      "deploy/wispctl",
      "deploy/systemd/wisp.service",
      "deploy/systemd/server.env.example",
      "deploy/docker/Dockerfile",
      "deploy/docker/compose.yaml",
      "deploy/tailscale/policy.hujson",
      "deploy/docker/master.key",
      "deploy/systemd/server.env",
    ];
    for (const file of fixtures) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), "test fixture");
    }
    await promisify(execFile)(process.execPath, [path.resolve("scripts/package-server.mjs")], { cwd: directory });
    expect(existsSync(path.join(directory, "release/server/deploy/wispctl"))).toBe(true);
    expect(existsSync(path.join(directory, "release/server/deploy/docker/master.key"))).toBe(false);
    expect(existsSync(path.join(directory, "release/server/deploy/systemd/server.env"))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
