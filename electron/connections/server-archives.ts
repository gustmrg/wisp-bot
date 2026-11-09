import { readFile } from "node:fs/promises";

import { parseServerArchiveHashes, type ServerArchiveHashes } from "../../shared/server-package.js";

/**
 * The hashes of this app's own server archives, which the release writes
 * next to the build. A development build has none, or ones for another
 * version, and installs servers from npm instead.
 */
export async function loadServerArchiveHashes(
  file: string,
  appVersion: string,
): Promise<ServerArchiveHashes | undefined> {
  try {
    const hashes = parseServerArchiveHashes(JSON.parse(await readFile(file, "utf8")));
    return hashes?.version === appVersion ? hashes : undefined;
  } catch {
    return undefined;
  }
}
