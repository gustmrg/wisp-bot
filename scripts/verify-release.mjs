import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag || tag !== `v${pkg.version}`) {
  throw new Error(`Release tag ${tag ?? "(missing)"} does not match package version v${pkg.version}.`);
}
console.log(`Release identity verified: ${tag}`);
