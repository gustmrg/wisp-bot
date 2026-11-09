import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveInstallCommand, explainInstallFailure } from "../../electron/connections/ssh-install.js";
import type { SshConnectionProfile } from "../../shared/connections.js";

const VERSION = "1.2.3";
const UPDATE_ID = "0b7f8a6e-2c1d-4e5f-9a8b-7c6d5e4f3a2b";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function executable(file: string, text: string): Promise<void> {
  await writeFile(file, text);
  await chmod(file, 0o755);
}

/**
 * A machine for the install script: a home, fake `uname`, `getconf` and
 * `curl` (which hands out a fixture archive and logs the URL; nothing reaches
 * the network), and the archive with a `wispctl` that answers the runtime
 * check and logs the setup it is asked to run.
 */
async function machine() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-archive-install-"));
  directories.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const log = path.join(root, "log");
  await mkdir(home);
  await mkdir(bin);
  await executable(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo "\${FAKE_UNAME_S:-Linux}" ;; -m) echo "\${FAKE_UNAME_M:-x86_64}" ;; esac\n`,
  );
  await executable(path.join(bin, "getconf"), `#!/bin/sh\n[ -n "$FAKE_GLIBC" ] || exit 1\necho "glibc $FAKE_GLIBC"\n`);
  await executable(
    path.join(bin, "curl"),
    `#!/bin/sh\nfor a; do last=$a; done\necho "curl $last" >>"$FAKE_LOG"\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$FAKE_ARCHIVE" "$2"\n`,
  );

  const name = `wisp-server-${VERSION}-linux-x64`;
  const build = path.join(root, "build", name);
  await mkdir(path.join(build, "bin"), { recursive: true });
  await executable(
    path.join(build, "bin/wispctl"),
    `#!/bin/sh
case "$1" in
  version) if [ -n "$FAKE_CANNOT_RUN" ]; then echo "canvas.node: cannot open shared object file" >&2; exit 1; fi ;;
  setup) echo "setup from $(dirname "$(dirname "$0")") $*" >>"$FAKE_LOG"; echo '{"version":"${VERSION}","port":8787,"runningVersion":"${VERSION}"}' ;;
esac
`,
  );
  const archive = path.join(root, `${name}.tar.gz`);
  spawnSync("tar", ["-czf", archive, "-C", path.join(root, "build"), name]);
  const sha = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const hashes = { version: VERSION, sha256: { x64: sha, arm64: "0".repeat(64) } };

  const run = (env: Record<string, string> = {}, hashesOverride = hashes) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "sh",
        ["-c", archiveInstallCommand(VERSION, 8787, UPDATE_ID, hashesOverride)],
        {
          env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            FAKE_LOG: log,
            FAKE_ARCHIVE: archive,
            FAKE_GLIBC: "2.36",
            ...env,
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
      );
    });
  const versions = path.join(home, ".local/lib/wisp-server/versions");
  const logged = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { home, versions, run, logged, hashes };
}

const profile: SshConnectionProfile = {
  id: "box",
  kind: "ssh",
  name: "Box",
  host: "test-host.invalid",
  serverPort: 8787,
};
const explain = (stderr: string) => explainInstallFailure(profile, VERSION, 1, stderr, false).message;

describe("installing a server archive over SSH", () => {
  it("downloads the archive for the machine, checks it, installs it, and runs its setup", async () => {
    const { versions, run, logged } = await machine();
    const result = await run();
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ version: VERSION });
    expect(result.stderr).toContain(`Downloading Wisp server ${VERSION} for x64…`);
    expect(await logged()).toEqual([
      `curl https://github.com/gustmrg/wisp-bot/releases/download/v${VERSION}/wisp-server-${VERSION}-linux-x64.tar.gz`,
      `setup from ${versions}/${VERSION} setup --json --no-pair --until-stdin-closes --port 8787 --update-id ${UPDATE_ID}`,
    ]);
    expect(await readFile(path.join(versions, VERSION, ".install-complete"), "utf8")).toBe(`${VERSION}\n`);
    // No lock and no download left behind.
    expect(await readdir(versions)).toEqual([VERSION]);
    await expect(stat(path.join(versions, "../.install.lock"))).rejects.toThrow();
  });

  it("reuses a version installed completely, and replaces one an interrupted run left", async () => {
    const { versions, run, logged } = await machine();
    await run();
    await run();
    expect((await logged()).filter((line) => line.startsWith("curl"))).toHaveLength(1);

    // An install that stopped before its marker, and a download that stopped halfway.
    await rm(path.join(versions, VERSION, ".install-complete"));
    await mkdir(path.join(versions, ".download-abc123"));
    expect(await run()).toMatchObject({ code: 0 });
    expect((await logged()).filter((line) => line.startsWith("curl"))).toHaveLength(2);
    expect(await readdir(versions)).toEqual([VERSION]);
  });

  it("takes over a lock its owner left when it died", async () => {
    const { versions, run } = await machine();
    const dead = spawnSync("true").pid;
    const lock = path.join(versions, "../.install.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "pid"), String(dead));
    expect(await run()).toMatchObject({ code: 0 });
  });

  it("installs nothing when the download does not match the hash this app carries", async () => {
    const { versions, run, logged, hashes } = await machine();
    const result = await run({}, { ...hashes, sha256: { ...hashes.sha256, x64: "f".repeat(64) } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("wisp-install: checksum");
    expect(await readdir(versions)).toEqual([]);
    expect((await logged()).some((line) => line.startsWith("setup"))).toBe(false);
    expect(explain(result.stderr)).toMatch(/does not match the one this app expects, so nothing was installed/);
  });

  it("installs nothing when the archive cannot run on the machine", async () => {
    const { versions, run } = await machine();
    const result = await run({ FAKE_CANNOT_RUN: "1" });
    expect(result.stderr).toContain("wisp-install: cannot-run");
    expect(await readdir(versions)).toEqual([]);
    expect(explain(result.stderr)).toBe(
      `Wisp server ${VERSION} cannot run on test-host.invalid: canvas.node: cannot open shared object file.`,
    );
  });

  it("refuses systems the archives are not built for, before downloading anything", async () => {
    const { run, logged } = await machine();
    for (const [env, reason, message] of [
      [{ FAKE_UNAME_M: "armv7l" }, "unsupported-system", /runs Linux armv7l the Wisp server is not built for/],
      [{ FAKE_GLIBC: "" }, "unsupported-libc", /has no GNU C library/],
      [{ FAKE_GLIBC: "2.27" }, "old-glibc", /has glibc 2\.27, but the Wisp server needs 2\.28 or later/],
    ] as const) {
      const result = await run(env);
      expect(result.stderr).toContain(`wisp-install: ${reason}`);
      expect(explain(result.stderr)).toMatch(message);
    }
    expect(await logged()).toEqual([]);
    expect((await run({ FAKE_UNAME_M: "aarch64", FAKE_GLIBC: "2.28" })).stderr).toContain("for arm64…");
  });
});
