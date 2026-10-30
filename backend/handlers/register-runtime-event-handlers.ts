import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { SavedRuntimeEvents } from "../../shared/runtime-events.js";
import type { WorkspaceAttachment } from "../../shared/workspace.js";
import { WispBackendError } from "../backend-error.js";
import type { RuntimeEventLog } from "../runtime-event-log.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import {
  parseConversationRequest,
  parseRuntimeEventLogRequest,
  parseRuntimeEventRecordingRequest,
} from "../validators.js";

/** Name of the file **Save to workspace** puts in the workspace inbox. */
export const SAVED_RUNTIME_EVENTS_FILE = "runtime-events.jsonl";

export interface RuntimeEventHandlerOptions {
  /** Whether the conversation exists and its agents run. */
  isRunning: (conversationId: string) => boolean;
  /** Writes a file into the conversation's workspace inbox, as an upload would. */
  receive: (
    conversationId: string,
    file: { name: string; size: number },
    content: AsyncIterable<Uint8Array>,
  ) => Promise<WorkspaceAttachment>;
}

/** The runtime events view (SWE-215). Only a running conversation can be recorded, read or saved. */
export function registerRuntimeEventHandlers(
  router: HandlerRouter,
  log: RuntimeEventLog,
  options: RuntimeEventHandlerOptions,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const requireRunning = (conversationId: string): void => {
    if (!options.isRunning(conversationId)) throw new WispBackendError("not_found", "The conversation was not found.");
  };
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.getRuntimeEvents,
      (payload) => {
        const { conversationId, after } = parseRuntimeEventLogRequest(payload);
        requireRunning(conversationId);
        return log.read(conversationId, after);
      },
    ],
    [
      WISP_IPC_CHANNELS.setRuntimeEventRecording,
      (payload) => {
        const { conversationId, recording } = parseRuntimeEventRecordingRequest(payload);
        requireRunning(conversationId);
        return log.setRecording(conversationId, recording);
      },
    ],
    [
      WISP_IPC_CHANNELS.clearRuntimeEvents,
      (payload) => {
        const { conversationId } = parseConversationRequest(payload);
        requireRunning(conversationId);
        return log.clear(conversationId);
      },
    ],
    [
      WISP_IPC_CHANNELS.saveRuntimeEventsToWorkspace,
      async (payload): Promise<SavedRuntimeEvents> => {
        const { conversationId } = parseConversationRequest(payload);
        requireRunning(conversationId);
        const contents = await log.contents(conversationId);
        if (!contents.length) throw new WispBackendError("invalid_request", "There are no runtime events to save.");
        const saved = await options.receive(
          conversationId,
          { name: SAVED_RUNTIME_EVENTS_FILE, size: contents.length },
          (async function* () {
            yield contents;
          })(),
        );
        return { path: saved.path, size: saved.size };
      },
    ],
  ]);
}
