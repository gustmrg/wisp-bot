import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installScript } from "../../electron/connections/ssh-install.js";

// The script runs on a Linux server; here it runs on this machine, in a home and PATH of its own.
const TOOLS = [
  "sh",
  "dirname",
  "uname",
  "grep",
  "head",
  "mktemp",
  "rm",
  "mv",
  "mkdir",
  "tar",
  "gzip",
  "sha256sum",
  "curl",
];
const linux = process.platform === "linux";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function machine() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-install-script-"));
  directories.push(root);
  const home = path.join(root, "home");
  const tools = path.join(root, "tools");
  await mkdir(home);
  await mkdir(tools);
  for (const tool of TOOLS) {
    await symlink(
      execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(),
      path.join(tools, tool),
    );
  }
  return { root, home, tools, log: path.join(root, "npx.log") };
}

/** A stand-in Node.js: `node -p …` prints its version; npx records how it was run. */
async function fakeNode(bin: string, version: string, log: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "node"), `#!/bin/sh\necho ${version}\n`);
  await writeFile(
    path.join(bin, "npx"),
    `#!/bin/sh\necho "npx $*" > ${JSON.stringify(log)}\necho "node $(command -v node)" >> ${JSON.stringify(log)}\n`,
  );
  await chmod(path.join(bin, "node"), 0o755);
  await chmod(path.join(bin, "npx"), 0o755);
}

function runScript(home: string, pathDirectories: string[], env: Record<string, string> = {}) {
  return spawnSync("sh", ["-s"], {
    input: installScript("1.2.3", 8787),
    env: { HOME: home, PATH: pathDirectories.join(":"), ...env },
    encoding: "utf8",
  });
}

describe.runIf(linux)("the server install script", () => {
  it("prefers a Node.js on the PATH, and passes over one that is too old for nvm's", async () => {
    const { root, home, tools, log } = await machine();
    await fakeNode(path.join(root, "usr/bin"), "22.20.0", log);
    let result = runScript(home, [path.join(root, "usr/bin"), tools]);
    expect(result.status).toBe(0);
    expect(await readFile(log, "utf8")).toBe(
      `npx --yes @gustmrg/wisp-server@1.2.3 setup --json --no-pair --until-stdin-closes --port 8787\nnode ${path.join(root, "usr/bin/node")}\n`,
    );

    await fakeNode(path.join(root, "usr/bin"), "20.11.1", log);
    const nvm = path.join(home, ".nvm/versions/node/v22.19.0/bin");
    await fakeNode(nvm, "22.19.0", log);
    result = runScript(home, [path.join(root, "usr/bin"), tools]);
    expect(result.status).toBe(0);
    // npx finds the same Node.js first on its PATH.
    expect(await readFile(log, "utf8")).toContain(`node ${path.join(nvm, "node")}\n`);
  });

  it("downloads Node.js 22 when there is none, checking it against SHASUMS256.txt", async () => {
    const { root, home, tools, log } = await machine();
    const arch = { x64: "x64", arm64: "arm64", arm: "armv7l" }[process.arch as string] ?? "x64";
    const name = `node-v22.99.0-linux-${arch}`;
    const dist = path.join(root, "dist");
    await fakeNode(path.join(dist, name, "bin"), "22.99.0", log);
    execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd: dist });
    const sum = createHash("sha256")
      .update(await readFile(path.join(dist, `${name}.tar.gz`)))
      .digest("hex");
    await writeFile(path.join(dist, "SHASUMS256.txt"), `${"0".repeat(64)}  ${name}.pkg\n${sum}  ${name}.tar.gz\n`);

    const result = runScript(home, [tools], { WISP_NODE_DIST: `file://${dist}` });
    expect(result.stderr).toContain(`Downloading ${name}…`);
    expect(result.status).toBe(0);
    const portable = path.join(home, ".local/lib/wisp-server/node/bin/node");
    expect(await readFile(log, "utf8")).toContain(`node ${portable}\n`);

    // Run again, it uses the Node.js it downloaded.
    await rm(path.join(dist, `${name}.tar.gz`));
    expect(runScript(home, [tools], { WISP_NODE_DIST: `file://${dist}` }).status).toBe(0);
  });

  it("refuses a download that does not match its checksum, and says what is missing", async () => {
    const { root, home, tools, log } = await machine();
    const arch = { x64: "x64", arm64: "arm64", arm: "armv7l" }[process.arch as string] ?? "x64";
    const name = `node-v22.99.0-linux-${arch}`;
    const dist = path.join(root, "dist");
    await fakeNode(path.join(dist, name, "bin"), "22.99.0", log);
    execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd: dist });
    await writeFile(path.join(dist, "SHASUMS256.txt"), `${"0".repeat(64)}  ${name}.tar.gz\n`);
    let result = runScript(home, [tools], { WISP_NODE_DIST: `file://${dist}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The Node.js download does not match its checksum.");

    await rm(path.join(tools, "curl"));
    result = runScript(home, [tools]);
    expect(result.stderr).toContain("Wisp needs curl or wget on this machine to download Node.js.");
  });
});
