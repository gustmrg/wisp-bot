import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = path.join(__dirname, "../../scripts/release-version.mjs");

function run(tags: string[], ...args: string[]) {
  const input = tags.flatMap((tag) => [`abc123\trefs/tags/v${tag}`, `def456\trefs/tags/v${tag}^{}`]).join("\n");
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

describe("release-version next-beta", () => {
  it("starts the next minor version's betas at 1", () => {
    expect(run(["0.17.4", "0.18.0"], "next-beta", "0.18.0").stdout).toBe("0.19.0-beta.1");
  });

  it("continues after the newest beta of that version", () => {
    const tags = ["0.18.0", "0.19.0-beta.1", "0.19.0-beta.3", "0.20.0-beta.7"];
    expect(run(tags, "next-beta", "0.18.0").stdout).toBe("0.19.0-beta.4");
  });
});

describe("release-version check", () => {
  it("accepts a release above every published version and starts its notes at the previous release", () => {
    const result = run(["0.18.0", "0.19.0-beta.1", "0.19.0-beta.2"], "check", "0.19.0");
    expect(result).toMatchObject({ status: 0, stdout: "v0.18.0" });
  });

  it("starts a beta's notes at the version just before it", () => {
    expect(run(["0.18.0", "0.19.0-beta.1"], "check", "0.19.0-beta.2").stdout).toBe("v0.19.0-beta.1");
    expect(run(["0.18.0"], "check", "0.19.0-beta.1").stdout).toBe("v0.18.0");
  });

  it("refuses a release that beta installs would never update to", () => {
    const result = run(["0.18.0", "0.19.0-beta.2"], "check", "0.18.1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Beta installs run v0.19.0-beta.2 and would never update to v0.18.1");
    expect(result.stderr).toContain("Release 0.19.0 or higher");
  });

  it("refuses a version below the latest release", () => {
    const result = run(["0.18.0"], "check", "0.17.5");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v0.18.0 is already out");
  });

  it("refuses an existing tag and versions the app does not recognize", () => {
    expect(run(["0.18.0"], "check", "0.18.0").stderr).toContain("Tag v0.18.0 already exists.");
    expect(run([], "check", "0.19.0-rc.1").stderr).toContain("is neither a release");
  });

  it("starts the first release's notes from the beginning", () => {
    expect(run([], "check", "0.1.0")).toMatchObject({ status: 0, stdout: "" });
  });
});
