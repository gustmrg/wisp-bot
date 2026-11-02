import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { CONTAINER_WORKSPACE } from "../shared/execution.js";
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
  const unresolved = path.resolve(workspaceDirectory, fromContainerPath(workspaceDirectory, requestedPath));
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

/**
 * Commands see the workspace at /workspace, so a Wisp also reaches for that
 * path in its file tools. It names the same files, so it is translated instead
 * of refused, and the result still goes through every check on the way out. A
 * real path inside the workspace wins, in case the workspace itself lives
 * under a host folder called /workspace.
 */
export function fromContainerPath(workspaceDirectory: string, requestedPath: string): string {
  if (!requestedPath.startsWith("/")) return requestedPath;
  const normalized = path.posix.normalize(requestedPath);
  if (normalized !== CONTAINER_WORKSPACE && !normalized.startsWith(`${CONTAINER_WORKSPACE}/`)) return requestedPath;
  if (isContainedPath(path.resolve(workspaceDirectory), path.resolve(requestedPath))) return requestedPath;
  return path.posix.relative(CONTAINER_WORKSPACE, normalized);
}

function isContainedPath(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function assertContainedPath(workspace: string, candidate: string): void {
  if (!isContainedPath(workspace, candidate)) {
    throw new WispBackendError("invalid_request", "The requested path is outside this Wisp's workspace.");
  }
}
