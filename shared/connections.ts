/**
 * Where the desktop app's backend runs: on this computer, or on a Wisp
 * server reached over SSH or a private HTTPS URL. The main process routes
 * every backend call to the active connection.
 */
export const LOCAL_CONNECTION_ID = "local";

export interface LocalConnectionProfile {
  id: typeof LOCAL_CONNECTION_ID;
  kind: "local";
  name: string;
}

export interface SshConnectionProfile {
  id: string;
  kind: "ssh";
  name: string;
  /** A host name, IP address, or alias from ~/.ssh/config. */
  host: string;
  user?: string;
  /** The SSH port; OpenSSH's configured port when omitted. */
  sshPort?: number;
  /** The port the Wisp server listens on, on the server's loopback. */
  serverPort: number;
}

export interface UrlConnectionProfile {
  id: string;
  kind: "url";
  name: string;
  /** An HTTPS origin, such as a Tailscale Serve address, or a loopback HTTP origin. */
  url: string;
}

export type RemoteConnectionProfile = SshConnectionProfile | UrlConnectionProfile;
export type ConnectionProfile = LocalConnectionProfile | RemoteConnectionProfile;

export type ConnectionProfileView = ConnectionProfile & {
  /** Whether this device holds credentials for the server. */
  paired: boolean;
};

export type ConnectionPhase =
  /** First run: nothing runs until the person chooses this computer or a server. */
  "choosing" | "local" | "connecting" | "pairing_required" | "connected" | "reconnecting" | "error";

export interface ConnectionStatus {
  profileId: string;
  phase: ConnectionPhase;
  message?: string;
  /** Set while Wisp sets the server up over SSH; the setup can then be cancelled. */
  installing?: boolean;
  /**
   * Changes whenever the renderer must reload everything from the backend:
   * after switching connections, connecting for the first time, or when a
   * reconnect cannot replay what was missed.
   */
  epoch: number;
}

export interface ConnectionsView {
  activeId: string;
  profiles: ConnectionProfileView[];
  status: ConnectionStatus;
  /** Whether pairing credentials are kept across restarts on this device. */
  secureStorageAvailable: boolean;
  /**
   * Whether this client can add, switch, or remove connections. False in the
   * browser app, which always talks to the server that served it.
   */
  canManage?: boolean;
}

export type SaveConnectionRequest =
  | (Omit<SshConnectionProfile, "id"> & { id?: string })
  | (Omit<UrlConnectionProfile, "id"> & { id?: string });

export interface ConnectionRequest {
  id: string;
}

export interface ActivateConnectionRequest {
  id: string;
  /** A code from `wispctl pair`, for servers that cannot provide one over SSH. */
  pairingCode?: string;
}
