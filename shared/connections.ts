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

/** A question OpenSSH asks while Wisp checks an SSH server, answered in the app instead of a terminal. */
export type SshPrompt =
  | {
      id: number;
      kind: "hostKey";
      /** The host as OpenSSH names it, such as "raspberrypi (100.64.0.1)". */
      host: string;
      keyType?: string;
      fingerprint?: string;
      message: string;
    }
  | {
      id: number;
      /** A password, key passphrase, or one-time code; never kept. */
      kind: "secret";
      message: string;
    }
  | {
      id: number;
      /** A yes or no question, such as allowing the use of an agent key. */
      kind: "confirm";
      message: string;
    }
  | {
      id: number;
      /** Tailscale SSH waits until the person approves the connection on this page; nothing to answer. */
      kind: "browser";
      url: string;
      message: string;
    };

/** A question from OpenSSH before the app numbers it. */
export type SshQuestion = {
  [Kind in SshPrompt["kind"]]: Omit<Extract<SshPrompt, { kind: Kind }>, "id">;
}[SshPrompt["kind"]];

export interface AnswerSshPromptRequest {
  id: number;
  /** "yes" or the secret; absent to refuse or cancel. */
  answer?: string;
}

/** What checking an SSH connection found on the server. */
export interface SshServerCheck {
  /** The Wisp server version installed there by its setup; absent when none is. */
  installedVersion?: string;
  /** This app's version, which an install or update would set up. */
  appVersion: string;
  /** Whether Wisp added its own key to the server, because only a password worked. */
  addedKey: boolean;
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
  /** What OpenSSH asks right now while Wisp checks a server. */
  sshPrompt?: SshPrompt;
  /** A server setup in progress, with its latest progress line. */
  installation?: { profileId: string; message?: string };
  /** Servers whose Wisps stop when nobody is logged in there: the setup could not turn on linger. */
  lingerNeeded?: string[];
}

export type SaveConnectionRequest =
  | (Omit<SshConnectionProfile, "id"> & { id?: string })
  | (Omit<UrlConnectionProfile, "id"> & { id?: string });

/** A machine on this computer's tailnet, from `tailscale status`. */
export interface TailnetMachine {
  /** The machine's name, such as "raspberrypi". */
  name: string;
  /** Its MagicDNS name, such as "raspberrypi.tail1234.ts.net"; connects whether or not short names resolve. */
  dnsName: string;
  ip?: string;
  online: boolean;
}

/** A machine named by a `Host` line of the user's ~/.ssh/config, as OpenSSH resolves it. */
export interface SshConfigHost {
  /** The name to connect to; OpenSSH applies the config's settings for it. */
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
}

export interface ConnectionRequest {
  id: string;
}

export interface ActivateConnectionRequest {
  id: string;
  /** A code from `wispctl pair`, for servers that cannot provide one over SSH. */
  pairingCode?: string;
}
