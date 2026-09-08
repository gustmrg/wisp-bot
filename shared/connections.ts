import type { BackendResult, EmptyResult } from "./contracts.js";
import type { RemoteOwner } from "./remote-protocol.js";

interface ProfileBase {
  id: string;
  name: string;
  expectedServerId?: string;
  lastConnectedAt?: string;
}
export interface LocalConnectionProfile extends ProfileBase {
  kind: "local";
}
export interface HttpsConnectionProfile extends ProfileBase {
  kind: "https";
  endpoint: string;
}
export interface SshConnectionProfile extends ProfileBase {
  kind: "ssh";
  /** Host name, IP address or an alias already configured in ~/.ssh/config. */
  host: string;
  username?: string;
  port: number;
  remotePort: number;
  sshAuthMode: "openssh" | "tailscale-ssh";
  /** Only a path/reference is stored; private keys remain outside the application. */
  identityFile?: string;
}
export type ConnectionProfile = LocalConnectionProfile | HttpsConnectionProfile | SshConnectionProfile;
export type ConnectionPhase =
  | "local"
  | "connecting"
  | "authenticating"
  | "host_verification_required"
  | "pairing_required"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";
export interface ConnectionState {
  phase: ConnectionPhase;
  profileId: string;
  generation: number;
  serverId?: string;
  owner?: RemoteOwner;
  message?: string;
  hostFingerprint?: string;
  authenticationUrl?: string;
}
export interface ConnectionApi {
  list(): Promise<BackendResult<ConnectionProfile[]>>;
  save(profile: ConnectionProfile): Promise<BackendResult<ConnectionProfile>>;
  delete(request: { id: string }): Promise<EmptyResult>;
  connect(request: { id: string; pairingCode?: string }): Promise<BackendResult<ConnectionState>>;
  disconnect(): Promise<BackendResult<ConnectionState>>;
  getState(): Promise<BackendResult<ConnectionState>>;
  trustHost(request: { id: string; fingerprint: string }): Promise<EmptyResult>;
  openAuthentication(): Promise<EmptyResult>;
  subscribeToState(listener: (state: ConnectionState) => void): () => void;
}
export const CONNECTION_IPC_CHANNELS = {
  list: "wisp:connections:list",
  save: "wisp:connections:save",
  delete: "wisp:connections:delete",
  connect: "wisp:connections:connect",
  disconnect: "wisp:connections:disconnect",
  getState: "wisp:connections:get-state",
  trustHost: "wisp:connections:trust-host",
  openAuthentication: "wisp:connections:open-authentication",
  state: "wisp:connections:state",
} as const;
