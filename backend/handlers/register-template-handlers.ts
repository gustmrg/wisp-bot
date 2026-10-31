import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import { parseDeleteWispTemplateRequest, parseSaveWispTemplateRequest } from "../validators.js";
import type { WispTemplateStore } from "../wisp-template-store.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerTemplateHandlers(
  router: HandlerRouter,
  store: WispTemplateStore,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.listWispTemplates, () => store.list()],
    [WISP_IPC_CHANNELS.saveWispTemplate, (payload) => store.save(parseSaveWispTemplateRequest(payload))],
    [
      WISP_IPC_CHANNELS.deleteWispTemplate,
      async (payload) => {
        await store.delete(parseDeleteWispTemplateRequest(payload).id);
        return {};
      },
    ],
  ]);
}
