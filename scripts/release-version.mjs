// Resolves and checks a release version against the tags already published.
// Reads `git ls-remote --tags origin` on stdin.
//
//   next-beta <current>  prints the next minor version's next beta
//   check <version>      fails unless every install can update to <version>,
//                        and prints the tag its release notes start from
import { readFileSync } from "node:fs";

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

function parse(version) {
  const match = PATTERN.exec(version);
  if (!match) return null;
  // A release sorts above every beta of the same version.
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}

function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const isBeta = (version) => version.includes("-");
const base = (version) => version.split("-")[0];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const published = readFileSync(0, "utf8")
  .split("\n")
  .map((line) => /refs\/tags\/v(\S+)$/.exec(line.trim())?.[1])
  .filter((version) => version && parse(version))
  .sort(compare);

const [command, version] = process.argv.slice(2);

if (command === "next-beta") {
  // 0.18.0 leads to 0.19.0-beta.1, then 0.19.0-beta.2, so every beta sorts
  // above the latest release.
  const [major, minor] = parse(base(version));
  const next = `${major}.${minor + 1}.0`;
  const last = Math.max(0, ...published.filter((tag) => base(tag) === next && isBeta(tag)).map((tag) => parse(tag)[3]));
  console.log(`${next}-beta.${last + 1}`);
} else if (command === "check") {
  // The app follows the beta channel only for versions named -beta.N.
  if (!parse(version ?? "")) fail(`${version} is neither a release (1.2.3) nor a beta (1.3.0-beta.1).`);
  if (published.includes(version)) fail(`Tag v${version} already exists.`);
  // Downgrades are disabled, so no install ever moves to a lower version.
  const newest = published.at(-1);
  if (newest && compare(version, newest) < 0) {
    fail(
      isBeta(newest)
        ? `Beta installs run v${newest} and would never update to v${version}. Release ${base(newest)} or higher (version: minor) so they receive it.`
        : `v${newest} is already out, and installs never update to a lower version such as v${version}.`,
    );
  }
  // A beta's notes list what changed since the version before it; a release's
  // list everything since the previous release, betas included.
  const previous = published.filter((tag) => isBeta(version) || !isBeta(tag)).at(-1);
  console.log(previous ? `v${previous}` : "");
} else {
  fail(`Unknown command ${command}. Use next-beta or check.`);
}
