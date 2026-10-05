import type { SequencedConversationAgentEvent } from "./contracts.js";
import type { ConversationDelta } from "./conversations.js";
import type { McpSettingsView } from "./mcp.js";

/**
 * The HTTP protocol a persistent Wisp server speaks. Operations reuse the
 * desktop `WispApi` names and payloads: `POST /api/v1/rpc/<operation>` takes
 * the same request the IPC channel takes and answers its `BackendResult`.
 * Push channels arrive on one server-sent event stream.
 */
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_API_PREFIX = "/api/v1";

/** Returned to paired devices only. */
export interface ServerDescriptor {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  /** Stable for the lifetime of the data directory; clients pin it after pairing. */
  serverId: string;
  /** Changes on every start; event cursors from another boot require a resync. */
  bootId: string;
  version: string;
  /** The `WispApi` operations this server answers. */
  operations: string[];
}

export interface PairRequest {
  code: string;
  deviceName: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface DeviceCredentials {
  deviceId: string;
  serverId: string;
  /** Sent as `Authorization: Bearer`; short-lived. */
  accessToken: string;
  accessExpiresAt: string;
  /** Exchanged once for new credentials; rotates on every use. */
  refreshToken: string;
}

/**
 * Something the server needs a screen for, asked of the desktop app running
 * on the same computer: a server only sends these to a local device.
 */
export type HostRequest =
  | { id: string; kind: "openPath"; path: string }
  | { id: string; kind: "openExternal"; url: string }
  | { id: string; kind: "selectFiles" };

/** The answer to a host request: `selectFiles` returns absolute paths; the others return nothing. */
export type HostResponse = { ok: true; value?: ReadonlyArray<string> } | { ok: false; message: string };

export interface RemoteEventPayloads {
  agentEvent: SequencedConversationAgentEvent;
  conversationChanged: ConversationDelta;
  mcpSettingsChanged: McpSettingsView;
  /** Sent only to the device that asked for the operation; never replayed. */
  hostRequest: HostRequest;
  /** The client's cursor is unknown (another boot, or older than the buffer): reload state. */
  resync: Record<string, never>;
}
export type RemoteEventType = keyof RemoteEventPayloads;

/** Transport failures that are not operation results. */
export type RemoteTransportErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "unavailable"
  | "internal_error";
