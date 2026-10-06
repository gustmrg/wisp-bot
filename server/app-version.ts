import { readFileSync } from "node:fs";
import path from "node:path";

/** The version of the package this file was built from, found next to the build output. */
export function readAppVersion(directory = __dirname): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const { version } = JSON.parse(readFileSync(path.join(directory, candidate), "utf8")) as { version?: unknown };
      if (typeof version === "string") return version;
    } catch {
      // Try the next location.
    }
  }
  return "0.0.0";
}
