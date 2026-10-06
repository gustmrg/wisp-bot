// Assembles a self-contained server package in release/server: the compiled
// backend, server, and shared code, the browser app, a manifest whose dependencies are pinned
// to the versions this repository was tested with, and the deployment files.
// Install it on the target with `npm install --omit=dev`.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "release", "server");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));

const rootManifest = await readJson("package.json");
const lock = await readJson("package-lock.json");
const manifest = await readJson("server/package.json");
manifest.version = rootManifest.version;
for (const name of Object.keys(manifest.dependencies)) {
  const installed = lock.packages[`node_modules/${name}`]?.version;
  if (!installed) throw new Error(`${name} is not in package-lock.json; run npm install first.`);
  manifest.dependencies[name] = installed;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const directory of ["backend", "server", "shared"]) {
  await cp(path.join(root, "dist-server", directory), path.join(output, directory), { recursive: true });
}
await cp(path.join(root, "deploy"), path.join(output, "deploy"), { recursive: true });
// The browser app, served by the server on every path outside the API.
await cp(path.join(root, "dist-web"), path.join(output, "web"), { recursive: true });
await cp(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
// The package's page on npm.
await cp(path.join(root, "server", "README.md"), path.join(output, "README.md"));
await writeFile(path.join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packaged wisp-server ${manifest.version} in ${path.relative(root, output)}`);
