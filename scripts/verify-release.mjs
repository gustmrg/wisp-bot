import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const ref = process.env.GITHUB_REF_NAME ?? process.argv[2];
const expectedTag = `v${pkg.version}`;

if (ref && ref !== "main" && ref !== expectedTag) {
  throw new Error(`Release ref ${ref} does not match package version ${expectedTag}.`);
}

console.log(`Release identity verified for version ${expectedTag} (ref: ${ref ?? "(local)"}).`);
