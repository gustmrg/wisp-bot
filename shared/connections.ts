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
  /**
   * The port the Wisp server listens on, on the server's loopback. Connecting
   * corrects it when `wispctl status` says another one.
   */
  serverPort: number;
}

/** The Wisp server's port when a connection does not give one, as `wispctl setup` uses. */
export const DEFAULT_SERVER_PORT = 8787;

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

/**
 * Why connecting or setting a server up failed, so the app can say what to
 * do about it: the host cannot be reached, it turned the SSH login away, its
 * host key is not trusted, the person cancelled, the Wisp server is missing
 * or stopped, Node.js is missing or too old, the server speaks another
 * protocol, it is another server than the one paired, another service
 * answers on the server's port, or the setup failed.
 */
export type ConnectionFailure =
  | "unreachable"
  | "auth"
  | "host_key"
  | "cancelled"
  | "not_installed"
  | "not_running"
  | "node"
  | "version"
  | "wrong_server"
  | "wrong_port"
  | "install";

/**
 * A step of connecting or of setting a server up. Connecting: start the
 * server on this computer, reach the host, sign in over SSH, pair this
 * device, reach the Wisp server, load the Wisps. Setting up: download the
 * setup, install the server, start its service, then connect.
 */
export type ConnectionStepId =
  | "start_local"
  | "reach"
  | "sign_in"
  | "pair"
  | "server"
  | "load"
  | "download"
  | "install"
  | "service"
  | "connect";

export type ConnectionStepState = "pending" | "active" | "done" | "failed" | "skipped";

export interface ConnectionStep {
  id: ConnectionStepId;
  state: ConnectionStepState;
  /** What the step is doing now, or why it failed. */
  detail?: string;
  /** Milliseconds since the epoch, on the device that runs the connection. */
  startedAt?: number;
  endedAt?: number;
}

/** The steps of the current attempt to connect, or of setting the server up. */
export interface ConnectionProgress {
  kind: "connect" | "install" | "update";
  steps: ConnectionStep[];
  /** For an update: the server version it replaces. */
  fromVersion?: string;
}

/** Automatic retries after the connection failed or dropped. */
export interface ConnectionRetry {
  /** When the first attempt failed, or the connection dropped. */
  since: number;
  /** Attempts that failed so far; a dropped connection is not one. */
  attempt: number;
  /** When the next attempt starts; unset while one is running. */
  nextAttemptAt?: number;
  /** Why the latest attempts failed, oldest first. */
  failures: Array<{ at: number; message: string }>;
}

export interface ConnectionStatus {
  profileId: string;
  phase: ConnectionPhase;
  message?: string;
  progress?: ConnectionProgress;
  /** Set when connecting or setting up failed, with OpenSSH's own output in `details` when there is some. */
  failure?: ConnectionFailure;
  details?: string;
  retry?: ConnectionRetry;
  /** The version of the server last reached; not set for this computer, which always matches the app. */
  serverVersion?: string;
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
  /** The name this device paired under, such as "Chrome on iPhone". Set in the browser app only. */
  deviceName?: string;
  /** A question OpenSSH asks while connecting, waiting for the person to answer. */
  sshPrompt?: SshPromptView;
  /**
   * Set in the browser app while a pairing code from a scanned link waits for
   * the person to name this device. The code itself never leaves the bridge.
   */
  pairingLink?: { deviceName: string };
}

/**
 * What OpenSSH asks: to trust an unknown host key, for a password, for the
 * passphrase of a key, to confirm the use of a key, or anything else the
 * server asks (such as a one-time code).
 */
export type SshPromptKind = "host_key" | "password" | "passphrase" | "confirm" | "secret";

export interface SshPromptView {
  id: string;
  kind: SshPromptKind;
  /** The SSH host the question is about, as written in the connection. */
  host: string;
  /** OpenSSH's own text, such as the host key fingerprint or the password prompt. */
  message: string;
  /** For a password: the public keys of this computer the password authorizes on the server. */
  keys?: string[];
  /** Set when the same question is asked again, because the last answer was not accepted. */
  retry?: boolean;
}

/** Answers an SSH question; no answer declines it. */
export interface AnswerSshPromptRequest {
  id: string;
  answer?: string;
}

export type SaveConnectionRequest =
  | (Omit<SshConnectionProfile, "id" | "serverPort"> & { id?: string; serverPort?: number })
  | (Omit<UrlConnectionProfile, "id"> & { id?: string });

export interface ConnectionRequest {
  id: string;
}

export interface ActivateConnectionRequest {
  id: string;
  /** A code from `wispctl pair`, for servers that cannot provide one over SSH. */
  pairingCode?: string;
  /** The name to pair under, shown in `wispctl devices`; the browser app asks for it when pairing from a link. */
  deviceName?: string;
}
