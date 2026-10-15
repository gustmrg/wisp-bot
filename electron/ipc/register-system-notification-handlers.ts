import {
  WISP_IPC_CHANNELS,
  type SystemNotificationKind,
  type SystemNotificationSettings,
  type SystemNotificationTarget,
} from "../../shared/contracts.js";
import { WispBackendError } from "../../backend/backend-error.js";
import {
  registerGuardedHandlers,
  type HandlerRouter,
  type SenderAuthorizer,
} from "../../backend/handlers/guarded-handlers.js";
import type { SystemNotifier } from "../system-notifications.js";

const KINDS = new Set<SystemNotificationKind>(["finished", "needs-input", "error"]);

export interface SystemNotificationHandlers {
  notifier: Pick<SystemNotifier, "configure" | "setFocus" | "test">;
  /** The target of a notification clicked while no window was open, taken once by the window it opened. */
  takeTarget(): SystemNotificationTarget | null;
}

export function registerSystemNotificationHandlers(
  router: HandlerRouter,
  { notifier, takeTarget }: SystemNotificationHandlers,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.configureSystemNotifications,
      (payload) => {
        notifier.configure(parseSettings(payload));
        return {};
      },
    ],
    [
      WISP_IPC_CHANNELS.setNotificationFocus,
      (payload) => {
        const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
        if (conversationId !== null && (typeof conversationId !== "string" || conversationId.length > 200)) {
          throw new WispBackendError("invalid_request", "The conversation is invalid.");
        }
        notifier.setFocus(conversationId);
        return {};
      },
    ],
    [
      WISP_IPC_CHANNELS.testSystemNotification,
      (payload) => {
        const kind = (payload as { kind?: unknown } | null)?.kind;
        if (!KINDS.has(kind as SystemNotificationKind)) {
          throw new WispBackendError("invalid_request", "The notification kind is invalid.");
        }
        notifier.test(kind as SystemNotificationKind);
        return {};
      },
    ],
    [WISP_IPC_CHANNELS.takeNotificationTarget, () => takeTarget()],
  ]);
}

function parseSettings(payload: unknown): SystemNotificationSettings {
  const record = (payload ?? {}) as Record<string, unknown>;
  const settings = {
    enabled: record.enabled,
    onCompletion: record.onCompletion,
    onApproval: record.onApproval,
    onError: record.onError,
  };
  if (!Object.values(settings).every((value) => typeof value === "boolean")) {
    throw new WispBackendError("invalid_request", "The notification settings are invalid.");
  }
  return settings as SystemNotificationSettings;
}
