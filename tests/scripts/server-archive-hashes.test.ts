import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = path.join(__dirname, "../../scripts/server-archive-hashes.mjs");
const tempDirs: string[] = [];

function makeWorkDir(version = "1.2.3"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wisp-archive-hashes-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }), "utf8");
  return dir;
}

function run(cwd: string, archivesDir: string, outputFile: string) {
  const result = spawnSync(process.execPath, [script, archivesDir, outputFile], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server-archive-hashes", () => {
  it("reads precomputed .sha256 files without requiring the tarballs", () => {
    const dir = makeWorkDir("0.29.0");
    const x64Hash = "a".repeat(64);
    const arm64Hash = "b".repeat(64);
    writeFileSync(
      path.join(dir, "wisp-server-0.29.0-linux-x64.tar.gz.sha256"),
      `${x64Hash}  wisp-server-0.29.0-linux-x64.tar.gz\n`,
    );
    writeFileSync(path.join(dir, "wisp-server-0.29.0-linux-arm64.tar.gz.sha256"), `${arm64Hash}\n`);

    const output = path.join(dir, "out/server-archives.json");
    const result = run(dir, dir, output);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      version: "0.29.0",
      sha256: { x64: x64Hash, arm64: arm64Hash },
    });
  });

  it("hashes .tar.gz archives directly when .sha256 files are absent", () => {
    const dir = makeWorkDir("0.29.0");
    const x64Data = Buffer.from("x64-archive");
    const arm64Data = Buffer.from("arm64-archive");
    writeFileSync(path.join(dir, "wisp-server-0.29.0-linux-x64.tar.gz"), x64Data);
    writeFileSync(path.join(dir, "wisp-server-0.29.0-linux-arm64.tar.gz"), arm64Data);

    const output = path.join(dir, "server-archives.json");
    const result = run(dir, dir, output);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      version: "0.29.0",
      sha256: {
        x64: createHash("sha256").update(x64Data).digest("hex"),
        arm64: createHash("sha256").update(arm64Data).digest("hex"),
      },
    });
  });

  it("rejects malformed or mismatched .sha256 files", () => {
    const dir = makeWorkDir("0.29.0");
    writeFileSync(
      path.join(dir, "wisp-server-0.29.0-linux-x64.tar.gz.sha256"),
      `${"a".repeat(64)}  wrong-file.tar.gz\n`,
    );
    writeFileSync(path.join(dir, "wisp-server-0.29.0-linux-arm64.tar.gz.sha256"), `${"b".repeat(64)}\n`);

    const result = run(dir, dir, path.join(dir, "server-archives.json"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid checksum");
  });

  it("fails when an architecture is missing", () => {
    const dir = makeWorkDir("0.29.0");
    writeFileSync(path.join(dir, "wisp-server-0.29.0-linux-x64.tar.gz.sha256"), `${"a".repeat(64)}\n`);

    const result = run(dir, dir, path.join(dir, "server-archives.json"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wisp-server-0.29.0-linux-arm64.tar.gz");
  });
});
