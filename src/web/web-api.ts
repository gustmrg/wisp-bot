import type { StoredSession } from "../../client/remote-client";
import { RemoteSession } from "../../client/remote-session";
import type { ConnectionsView, ConnectionStatus } from "../../shared/connections";
import type { BackendResult, WispApi } from "../../shared/contracts";
import { RUNTIME_OPERATIONS } from "../../shared/runtime-operations";

/** The browser app's single connection: the server that served it. */
export const WEB_CONNECTION_ID = "server";
const SESSION_KEY = "wisp.session";

export interface WebApiOptions {
  /** The server's origin, which is also this page's. */
  origin: string;
  /** Keeps which device this browser is; the session tokens themselves stay in HttpOnly cookies. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  deviceName: string;
  appVersion: string;
  fetch?: typeof fetch;
  /** Asks the person for files to attach; resolves empty when dismissed. Defaults to the browser's file picker. */
  pickFiles?: () => Promise<ReadonlyArray<File>>;
}

type Listener<T> = (value: T) => void;

/**
 * `WispApi` for the browser app. Every Wisp operation goes to the server that
 * served the page, and its events arrive on one stream; actions that belong
 * to the desktop app (updates, launch at login, choosing servers) report that
 * they are unavailable.
 */
export function createWebWispApi(options: WebApiOptions): WispApi {
  const host = new URL(options.origin).host;
  const listeners = {
    agentEvent: new Set<Listener<unknown>>(),
    conversationChanged: new Set<Listener<unknown>>(),
    mcpSettingsChanged: new Set<Listener<unknown>>(),
    connections: new Set<Listener<ConnectionsView>>(),
  };
  let status: ConnectionStatus = { profileId: WEB_CONNECTION_ID, phase: "connecting", epoch: 0 };
  const loadSession = (): StoredSession | undefined => {
    try {
      const stored = options.storage.getItem(SESSION_KEY);
      return stored ? (JSON.parse(stored) as StoredSession) : undefined;
    } catch {
      return undefined;
    }
  };
  const view = (): ConnectionsView => ({
    activeId: WEB_CONNECTION_ID,
    profiles: [{ id: WEB_CONNECTION_ID, kind: "url", name: host, url: options.origin, paired: Boolean(loadSession()) }],
    status: { ...status },
    secureStorageAvailable: true,
    canManage: false,
  });
  const publish = (): void => {
    const current = view();
    for (const listener of listeners.connections) listener(current);
  };
  const session = new RemoteSession({
    serverName: host,
    deviceName: options.deviceName,
    cookies: true,
    openTransport: async () => ({
      baseUrl: options.origin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      closed: new Promise(() => undefined),
      close: () => undefined,
    }),
    credentials: {
      load: loadSession,
      save: async (value) => {
        if (value) options.storage.setItem(SESSION_KEY, JSON.stringify(value));
        else options.storage.removeItem(SESSION_KEY);
      },
    },
    onStatus: (phase, message) => {
      status = { profileId: WEB_CONNECTION_ID, phase, epoch: status.epoch, ...(message ? { message } : {}) };
      publish();
    },
    onEvent: (type, payload) => {
      for (const listener of listeners[type]) listener(payload);
    },
    onReset: () => {
      status = { ...status, epoch: status.epoch + 1 };
      publish();
    },
  });
  session.start(undefined, false);

  const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
  const desktopOnly = async (): Promise<BackendResult<never>> => ({
    ok: false,
    error: { code: "unsupported", message: "This is available in the Wisp desktop app.", retryable: false },
  });
  const subscribe =
    <T>(set: Set<Listener<T>>) =>
    (listener: Listener<T>): (() => void) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    };

  const api: Record<string, unknown> = {
    subscribeToAgentEvents: subscribe(listeners.agentEvent),
    subscribeToConversationChanges: subscribe(listeners.conversationChanged),
    subscribeToMcpSettings: subscribe(listeners.mcpSettingsChanged),
    subscribeToConnections: subscribe(listeners.connections),
    getLaunchAtLoginState: async () =>
      ok({ supported: false, enabled: false, reason: "Launch at login is part of the Wisp desktop app." }),
    setLaunchAtLogin: desktopOnly,
    getUpdateState: async () => ok({ phase: "up-to-date", currentVersion: options.appVersion }),
    checkForUpdates: desktopOnly,
    downloadUpdate: desktopOnly,
    installUpdate: desktopOnly,
    openReleasesPage: desktopOnly,
    subscribeToUpdateState: () => () => undefined,
    getConnections: async () => ok(view()),
    saveConnection: desktopOnly,
    // Removing the only connection signs this browser out.
    removeConnection: async () => {
      await session.signOut();
      return ok(view());
    },
    activateConnection: async (request: { pairingCode?: string }) => {
      session.start(request.pairingCode);
      return ok(view());
    },
    installServer: desktopOnly,
    cancelServerInstall: desktopOnly,
    listSshHosts: desktopOnly,
    checkSshServer: desktopOnly,
    cancelSshCheck: desktopOnly,
    answerSshPrompt: desktopOnly,
    listTailnetMachines: desktopOnly,
    enableLinger: desktopOnly,
    retryConnection: async () => {
      session.start();
      return ok(view());
    },
  };
  for (const operation of RUNTIME_OPERATIONS) {
    api[operation] = (payload?: unknown) => session.call(operation, payload);
  }
  // The server has no screen here: the browser picks the files and sends them.
  const pickFiles = options.pickFiles ?? pickFilesWithInput;
  api.attachWorkspaceFiles = async (request: { conversationId: string }) =>
    session.attachFiles(
      request.conversationId,
      (await pickFiles()).map((file) => ({ name: file.name, content: file })),
    );
  return api as unknown as WispApi;
}

/**
 * Opens the browser's file picker. It must run inside the click that asked
 * for it, before any `await`, or browsers refuse to show the picker.
 */
function pickFilesWithInput(): Promise<ReadonlyArray<File>> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

/** A readable name for this browser, shown in `wispctl devices`. */
export function browserDeviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "a device";
  return `${browser} on ${device}`;
}
