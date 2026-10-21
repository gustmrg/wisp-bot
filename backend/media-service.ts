import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { mediaMimeType, mediaName, normalizeMediaPath, referencedMediaPaths } from "../shared/media.js";
import type { ReadConversationMediaRequest } from "../shared/media.js";
import { formatBytes } from "../shared/workspace.js";
import type { ConversationRepository } from "./conversation-repository.js";
import { WispBackendError } from "./backend-error.js";
import { resolveWorkspacePath } from "./workspace-path.js";

/** A workspace file opened for a device; the caller reads it and closes it. */
export interface OpenedMedia {
  name: string;
  mimeType: string;
  size: number;
  file: FileHandle;
}

/**
 * Serves the workspace files a Wisp shows in its replies (SWE-177). A file is
 * served only when the Wisp's own message in that conversation refers to it,
 * so a device cannot read the rest of the workspace through a reply, and only
 * from inside the conversation's workspace.
 */
export class ConversationMediaService {
  constructor(private readonly repository: Pick<ConversationRepository, "getMessage" | "getWorkspaceDirectory">) {}

  async open(request: ReadConversationMediaRequest): Promise<OpenedMedia> {
    const message = await this.repository.getMessage(request.conversationId, request.messageId);
    const path = normalizeMediaPath(request.path);
    if (message?.type !== "incoming" || !referencedMediaPaths(message.text).has(path)) {
      throw new WispBackendError("not_found", "This file is not shown in that message.");
    }
    const workspace = this.repository.getWorkspaceDirectory(request.conversationId);
    let canonicalPath: string;
    try {
      ({ canonicalPath } = await resolveWorkspacePath(workspace, path, false));
    } catch {
      throw new WispBackendError("not_found", "The file is no longer in the workspace.");
    }
    let file: FileHandle;
    try {
      file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new WispBackendError("not_found", "The file is no longer in the workspace.");
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new WispBackendError("not_found", "This is not a file.");
      if (request.maxBytes !== undefined && info.size > request.maxBytes) {
        throw new WispBackendError(
          "too_large",
          `This file is ${formatBytes(info.size)}, more than ${formatBytes(request.maxBytes)}.`,
        );
      }
      return { name: mediaName(path), mimeType: mediaMimeType(path), size: info.size, file };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}
