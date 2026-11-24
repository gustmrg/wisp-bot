// Writes the SHA-256 of a version's server archives as JSON, for the desktop
// app to carry: node scripts/server-archive-hashes.mjs <archives dir> <output>.
// Reads precomputed <archive>.sha256 files when present, or hashes the .tar.gz
// archives directly. Both architectures must be there; the app installs on either.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Usage: server-archive-hashes.mjs <archives dir> <output>");
const { version } = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const sha256 = {};
for (const arch of ["x64", "arm64"]) {
  const archive = `wisp-server-${version}-linux-${arch}.tar.gz`;
  const hashFile = path.join(directory, `${archive}.sha256`);
  const precomputed = await readFile(hashFile, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (precomputed !== undefined) {
    const [digest, name] = precomputed.trim().split(/\s+/);
    if (!SHA256_HEX.test(digest ?? "") || (name && name !== archive)) {
      throw new Error(`Invalid checksum in ${hashFile}.`);
    }
    sha256[arch] = digest;
  } else {
    const file = path.join(directory, archive);
    sha256[arch] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ version, sha256 }, null, 2)}\n`);
console.log(`Wrote the hashes of the ${version} server archives to ${output}.`);
