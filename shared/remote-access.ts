/**
 * Remote access to this computer: while it is on, the desktop app keeps its
 * Wisp server running, even with every window closed, and other devices
 * reach it through a private HTTPS proxy such as Tailscale Serve, pairing
 * the same way they pair with a Wisp server.
 */

/** The loopback port a proxy forwards to unless the person picks another. */
export const DEFAULT_REMOTE_ACCESS_PORT = 8787;

export interface PairedDeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** This computer's own app, which pairs by itself and cannot be revoked here. */
  local: boolean;
}

export interface RemoteAccessView {
  enabled: boolean;
  /** The loopback port the proxy forwards to. */
  port: number;
  /** The exact HTTPS origin the proxy serves, such as https://laptop.tailnet.ts.net. */
  publicOrigin?: string;
  /** Whether this build carries the browser app other devices open; without it they reach only the API. */
  webAppAvailable: boolean;
  /** Devices paired with Wisps on this computer, listed while remote access is on. */
  devices: PairedDeviceView[];
  /** Why Wisps on this computer could not be reached, such as a port already in use. */
  error?: string;
}

export interface SaveRemoteAccessRequest {
  enabled: boolean;
  port: number;
  publicOrigin?: string;
}

/** A one-time code for a new device, and the link a QR code carries. */
export interface RemoteAccessPairing {
  code: string;
  expiresAt: string;
  /** `<public origin>/#pair=<code>`: opening it pairs in one step. */
  link: string;
}

export interface RevokeRemoteDeviceRequest {
  deviceId: string;
}
