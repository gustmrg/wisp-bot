import type { BackendErrorCode, SequencedConversationAgentEvent } from "./contracts.js";
import type { ConversationStateView } from "./conversations.js";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_API_PREFIX = "/api/v1";
export const REMOTE_STATE_CHANNEL = "wisp:conversations:state";
export interface RemoteOwner {
  id: string;
  name: string;
}
export interface RemoteServerDescriptor {
  protocolVersion: number;
  serverId: string;
  bootId: string;
  version: string;
  owner: RemoteOwner;
  capabilities: string[];
  limits: { maxPendingPerConversation: number; maxRunning: number; maxMessageBytes: number };
}
export interface RemoteSnapshot {
  serverId: string;
  bootId: string;
  cursor: string;
  revision: number;
  state: ConversationStateView;
  revisions: Record<string, number>;
  settingsRevision: number;
}
export interface RemoteEvent {
  protocolVersion: number;
  serverId: string;
  bootId: string;
  eventId: string;
  type: "agent" | "state_changed" | "settings_changed" | "request_changed" | "devices_changed";
  occurredAt: string;
  conversationId?: string;
  requestId?: string;
  revision?: number;
  payload: SequencedConversationAgentEvent | Record<string, unknown>;
}
export interface DeviceCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  deviceId: string;
  serverId: string;
  csrfToken?: string;
}
export interface WebSession {
  deviceId: string;
  serverId: string;
  csrfToken: string;
  expiresAt: string;
}
export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string | null;
}
export interface RemoteRequestState {
  requestId: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  revision: number;
}
export class RemoteTransportError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RemoteTransportError";
  }
}
