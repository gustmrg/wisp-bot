// Writes the SHA-256 of a version's server archives as JSON, for the desktop
// app to carry: node scripts/server-archive-hashes.mjs <archives dir> <output>.
// Both archives must be there; the app installs on either processor.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Usage: server-archive-hashes.mjs <archives dir> <output>");
const { version } = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const sha256 = {};
for (const arch of ["x64", "arm64"]) {
  const file = path.join(directory, `wisp-server-${version}-linux-${arch}.tar.gz`);
  sha256[arch] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ version, sha256 }, null, 2)}\n`);
console.log(`Wrote the hashes of the ${version} server archives to ${output}.`);
