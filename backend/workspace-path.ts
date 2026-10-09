import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { WispBackendError } from "./backend-error.js";

export interface ResolvedWorkspacePath {
  canonicalPath: string;
  relativePath: string;
  exists: boolean;
}

/**
 * Resolves a path a tool asked for inside a Wisp's workspace, following
 * symbolic links, and refuses anything that lands outside it.
 */
export async function resolveWorkspacePath(
  workspaceDirectory: string,
  requestedPath: string,
  allowMissing: boolean,
): Promise<ResolvedWorkspacePath> {
  const workspace = await realpath(workspaceDirectory);
  const unresolved = path.resolve(workspaceDirectory, requestedPath);
  assertContainedPath(path.resolve(workspaceDirectory), unresolved);
  let canonicalPath: string;
  let exists = true;
  try {
    canonicalPath = await realpath(unresolved);
  } catch {
    if (!allowMissing) throw new WispBackendError("invalid_request", "The requested path does not exist.");
    exists = false;
    try {
      await lstat(unresolved);
      throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let ancestor = path.dirname(unresolved);
    while (true) {
      try {
        await lstat(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new WispBackendError("invalid_request", "The requested path is invalid.");
        ancestor = parent;
        continue;
      }
      try {
        const canonicalAncestor = await realpath(ancestor);
        canonicalPath = path.resolve(canonicalAncestor, path.relative(ancestor, unresolved));
        break;
      } catch {
        throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
      }
    }
  }
  assertContainedPath(workspace, canonicalPath!);
  const relative = path.relative(workspace, canonicalPath!);
  return { canonicalPath: canonicalPath!, relativePath: relative || ".", exists };
}

function assertContainedPath(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WispBackendError("invalid_request", "The requested path is outside this Wisp's workspace.");
  }
}
