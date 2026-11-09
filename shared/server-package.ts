/** The npm package that installs a headless Wisp server; its version always matches the desktop app's. */
export const WISP_SERVER_PACKAGE = "@gustmrg/wisp-server";

/** Versions the desktop app may pass to a remote shell; anything else is never interpolated into a command. */
export const SERVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The processors a server archive is built for; each needs Linux with glibc 2.28 or later. */
export const SERVER_ARCHIVE_ARCHES = ["x64", "arm64"] as const;
export type ServerArchiveArch = (typeof SERVER_ARCHIVE_ARCHES)[number];

/**
 * The file at the top of an extracted server archive that names what it holds.
 * The server also reads it to tell an archive install from the npm package.
 */
export const SERVER_ARCHIVE_MANIFEST = "wisp-server-archive.json";

export interface ServerArchiveManifest {
  version: string;
  platform: "linux";
  arch: ServerArchiveArch;
  /** The version of the Node.js runtime inside the archive. */
  node: string;
}

/** The archive's base name, also its top-level folder: `wisp-server-1.2.3-linux-arm64`. */
export function serverArchiveName(version: string, arch: ServerArchiveArch): string {
  return `wisp-server-${version}-linux-${arch}`;
}

/** Where each release's server archives are published, under `v<version>/`. */
export const SERVER_RELEASES_URL = "https://github.com/gustmrg/wisp-bot/releases/download";

/**
 * The SHA-256 of each server archive of one version. The release builds it
 * into the desktop app, so the app checks a download against what it carries
 * instead of a checksum file served next to the archive.
 */
export interface ServerArchiveHashes {
  version: string;
  sha256: Record<ServerArchiveArch, string>;
}

export function parseServerArchiveHashes(value: unknown): ServerArchiveHashes | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { version, sha256 } = value as { version?: unknown; sha256?: Record<string, unknown> };
  if (typeof version !== "string" || !SERVER_VERSION_PATTERN.test(version) || !sha256 || typeof sha256 !== "object") {
    return undefined;
  }
  const hashes = {} as Record<ServerArchiveArch, string>;
  for (const arch of SERVER_ARCHIVE_ARCHES) {
    const hash = sha256[arch];
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
    hashes[arch] = hash;
  }
  return { version, sha256: hashes };
}
