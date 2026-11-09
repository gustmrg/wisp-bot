// Builds release/wisp-server-<version>-linux-<arch>.tar.gz from the server
// package in release/server (`npm run package:server`): that package with its
// production dependencies for one processor, and the Node.js runtime it runs
// on, so the machine needs neither Node.js nor npm.
//
//   node scripts/package-server-archive.mjs [--arch x64|arm64]
//
// The archive holds one folder, named like the archive:
//   bin/wisp-server, bin/wispctl   the command line, run with the bundled Node.js
//   runtime/node, runtime/LICENSE  Node.js
//   app/                           the server package and its node_modules
//   wisp-server-archive.json       version, platform, processor, Node.js version
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Node.js 22 LTS. Raise it with each 22.x security release; the minimum glibc is 2.28. */
const NODE_VERSION = "22.23.4";
/** The ELF machine of each processor, to catch a native module built for another one. */
const ELF_MACHINE = { x64: 62, arm64: 183 };
/** Claude Code's own binaries: the server runs the `claude` installed on its machine instead. */
const LEFT_OUT = [/^@anthropic-ai\/claude-agent-sdk-/];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const arch = argument("--arch") ?? process.arch;
if (!(arch in ELF_MACHINE)) throw new Error(`Server archives are built for x64 and arm64, not ${arch}.`);

const manifest = JSON.parse(await readFile(path.join(release, "server", "package.json"), "utf8"));
const version = manifest.version;
const name = `wisp-server-${version}-linux-${arch}`;
const staging = path.join(release, "server-archive");
const top = path.join(staging, name);
const output = path.join(release, `${name}.tar.gz`);

await rm(staging, { recursive: true, force: true });
await mkdir(top, { recursive: true });

// The server package, with the dependencies npm installs on that processor and glibc.
const app = path.join(top, "app");
await cp(path.join(release, "server"), app, {
  recursive: true,
  // The Docker files build from a checkout; the README is the npm page.
  filter: (source) => !["deploy", "README.md"].includes(path.relative(path.join(release, "server"), source)),
});
execFileSync(
  "npm",
  [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=error",
    "--os=linux",
    `--cpu=${arch}`,
    "--libc=glibc",
  ],
  // A personal allow-scripts setting makes npm refuse a project install.
  { cwd: app, stdio: "inherit", env: { ...process.env, npm_config_allow_scripts: "" } },
);
const modules = path.join(app, "node_modules");
for (const scope of await readdir(modules)) {
  const names = scope.startsWith("@")
    ? (await readdir(path.join(modules, scope))).map((entry) => `${scope}/${entry}`)
    : [scope];
  for (const entry of names) {
    if (LEFT_OUT.some((pattern) => pattern.test(entry))) await rm(path.join(modules, entry), { recursive: true });
  }
}
await prunePrebuilds(modules);
await checkNativeModules(modules);

// Node.js, checked against the release's published checksums.
const runtime = path.join(top, "runtime");
await mkdir(runtime);
const node = await downloadNode();
execFileSync("tar", [
  "-xJf",
  node,
  "-C",
  runtime,
  "--strip-components=1",
  `node-v${NODE_VERSION}-linux-${arch}/bin/node`,
  `node-v${NODE_VERSION}-linux-${arch}/LICENSE`,
]);
await cp(path.join(runtime, "bin", "node"), path.join(runtime, "node"));
await rm(path.join(runtime, "bin"), { recursive: true });

const bin = path.join(top, "bin");
await mkdir(bin);
for (const command of ["wisp-server", "wispctl"]) {
  const file = path.join(bin, command);
  await writeFile(
    file,
    `#!/bin/sh
# The Wisp server's command line, run with the Node.js in this archive.
root=$(dirname "$(dirname "$(readlink -f "$0")")")
exec "$root/runtime/node" "$root/app/server/cli.js" "$@"
`,
  );
  await chmod(file, 0o755);
}
await cp(path.join(root, "LICENSE"), path.join(top, "LICENSE"));
await writeFile(
  path.join(top, "wisp-server-archive.json"),
  `${JSON.stringify({ version, platform: "linux", arch, node: NODE_VERSION }, null, 2)}\n`,
);

await rm(output, { force: true });
execFileSync("tar", ["-czf", output, "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "-C", staging, name]);
await rm(staging, { recursive: true, force: true });
const { size } = await stat(output);
console.log(`Packaged ${path.relative(root, output)} (${(size / 1024 / 1024).toFixed(1)} MB, Node.js ${NODE_VERSION})`);

function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Packages that ship prebuilt binaries for every platform keep only this one's. */
async function prunePrebuilds(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() || path.basename(entry.parentPath) !== "prebuilds") continue;
    if (!new RegExp(`^linux-${arch}(?:$|[-.@])`).test(entry.name) || /musl/.test(entry.name)) {
      await rm(path.join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
}

/** Fails on a native module for another processor or C library, which would only fail on the server. */
async function checkNativeModules(directory) {
  const wrong = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".node")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, file);
    const header = Buffer.alloc(20);
    const handle = await open(file, "r");
    await handle.read(header, 0, 20, 0);
    await handle.close();
    const elf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (!elf || header.readUInt16LE(18) !== ELF_MACHINE[arch] || /musl/.test(relative)) wrong.push(relative);
  }
  if (wrong.length) throw new Error(`Native modules not built for linux-${arch} with glibc:\n${wrong.join("\n")}`);
}

/** The Node.js release for this processor, downloaded once into release/.node-cache. */
async function downloadNode() {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const file = `node-v${NODE_VERSION}-linux-${arch}.tar.xz`;
  const cache = path.join(release, ".node-cache");
  const target = path.join(cache, file);
  await mkdir(cache, { recursive: true });
  const sums = await fetchOk(`${base}/SHASUMS256.txt`).then((response) => response.text());
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, entry]) => entry === file)?.[0];
  if (!expected) throw new Error(`${file} is not in the checksums of Node.js ${NODE_VERSION}.`);
  const cached = await readFile(target).catch(() => undefined);
  const data =
    cached && sha256(cached) === expected
      ? cached
      : Buffer.from(await (await fetchOk(`${base}/${file}`)).arrayBuffer());
  if (sha256(data) !== expected) throw new Error(`${file} does not match its published checksum.`);
  await writeFile(target, data);
  return target;
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
