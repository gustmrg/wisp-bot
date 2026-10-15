import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../backend/atomic-file.js";
import { WispBackendError } from "../../backend/backend-error.js";
import { pairingLink } from "../../shared/pairing-link.js";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  type PairedDeviceView,
  type RemoteAccessPairing,
  type RemoteAccessView,
} from "../../shared/remote-access.js";
import type { LocalServer, LocalServerExposure } from "./local-server.js";

const SETTINGS_FILE = "remote-access.json";
const CHECK_TIMEOUT_MS = 10_000;

interface RemoteAccessSettings {
  enabled: boolean;
  port: number;
  publicOrigin?: string;
}

export interface RemoteAccessServiceOptions {
  /** Where `remote-access.json` is kept: the app's data directory. */
  directory: string;
  localServer: LocalServer;
  /** Whether this build carries the browser app the local server serves to other devices. */
  webAppAvailable: boolean;
  /** Exposes Wisps on this computer, or stops exposing them; restarts the local server when that changes. */
  apply(exposure: LocalServerExposure | undefined): Promise<void>;
  /** Reaches the address through its proxy, to check it leads to this computer; tests substitute a fake. */
  fetch: typeof fetch;
}

const invalid = (message: string): WispBackendError => new WispBackendError("invalid_request", message);

/**
 * Remote access to Wisps on this computer. The setting lives with the app,
 * not the server, since it decides how the app starts its server: on a fixed
 * loopback port behind a private HTTPS proxy, serving the browser app, kept
 * running while the app runs. Pairing and devices go through the server's
 * administrative commands, which only this app can send.
 */
export class RemoteAccessService {
  private settings: RemoteAccessSettings = { enabled: false, port: DEFAULT_REMOTE_ACCESS_PORT };
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RemoteAccessServiceOptions) {}

  /** Reads the saved setting; an unreadable file leaves remote access off. */
  async load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(path.join(this.options.directory, SETTINGS_FILE), "utf8"));
    } catch {
      return;
    }
    try {
      const { version, ...settings } = (stored ?? {}) as { version?: unknown };
      if (version === 1) this.settings = parseSettings(settings);
    } catch {
      // Edited into an invalid shape: remote access stays off until saved again.
    }
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** How the local server is exposed, or undefined while remote access is off. */
  exposure(): LocalServerExposure | undefined {
    const { enabled, port, publicOrigin } = this.settings;
    return enabled && publicOrigin ? { port, publicOrigin } : undefined;
  }

  /** Called with whether remote access is on, whenever that changes. */
  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async view(): Promise<RemoteAccessView> {
    const { enabled, port, publicOrigin } = this.settings;
    const view: RemoteAccessView = {
      enabled,
      port,
      ...(publicOrigin ? { publicOrigin } : {}),
      webAppAvailable: this.options.webAppAvailable,
      devices: [],
    };
    if (!enabled) return view;
    try {
      return { ...view, devices: await this.devices() };
    } catch (error) {
      return { ...view, error: error instanceof Error ? error.message : "Wisps on this computer are unavailable." };
    }
  }

  /**
   * Saves the setting and applies it. Turning remote access on, or changing
   * its address or port while it is on, first checks that the address reaches
   * this computer's server; when it does not, nothing changes and the error
   * says what to fix.
   */
  save(request: unknown): Promise<RemoteAccessView> {
    const saving = this.saving.then(() => this.saveNow(request));
    this.saving = saving.catch(() => undefined);
    return saving;
  }

  private async saveNow(request: unknown): Promise<RemoteAccessView> {
    const settings = parseSettings(request);
    const previous = this.settings;
    this.settings = settings;
    await this.options.apply(this.exposure());
    const exposure = this.exposure();
    if (exposure) {
      const problem = await this.check(exposure);
      if (problem) {
        this.settings = previous;
        await this.options.apply(this.exposure());
        throw invalid(problem);
      }
    }
    await writeFileAtomically(
      path.join(this.options.directory, SETTINGS_FILE),
      `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`,
    );
    if (previous.enabled !== settings.enabled) for (const listener of this.listeners) listener(settings.enabled);
    return this.view();
  }

  /** Why the address does not reach this computer's server, or undefined when it does. */
  private async check({ port, publicOrigin }: LocalServerExposure): Promise<string | undefined> {
    let serverId: unknown;
    try {
      await this.options.localServer.ensureRunning();
      serverId = ((await this.options.localServer.admin({ command: "status" })) as { serverId?: unknown }).serverId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return /EADDRINUSE/.test(message)
        ? `Another program already uses port ${port} on this computer. Choose another port, and point Tailscale Serve at it.`
        : message || "Wisps on this computer could not start.";
    }
    let response: Response;
    try {
      response = await this.options.fetch(`${publicOrigin}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch {
      return `Wisp could not reach ${publicOrigin}. Check that Tailscale is running on this computer, and that the address is the one tailscale serve status shows.`;
    }
    const health = (await response.json().catch(() => undefined)) as { value?: { serverId?: unknown } } | undefined;
    if (!response.ok || health?.value?.serverId === undefined) {
      return `${publicOrigin} answers, but Wisp does not: Tailscale Serve is not forwarding it to port ${port}. Run tailscale serve --bg http://127.0.0.1:${port}.`;
    }
    if (health.value.serverId !== serverId) {
      return `${publicOrigin} reaches another Wisp server, not the one on this computer. Run tailscale serve --bg http://127.0.0.1:${port} on this computer.`;
    }
    return undefined;
  }

  /** A one-time code for a new device, with the link its QR code carries. */
  async pair(): Promise<RemoteAccessPairing> {
    const exposure = this.exposure();
    if (!exposure) throw invalid("Turn on remote access to pair a device with this computer.");
    await this.options.localServer.ensureRunning();
    const pairing = (await this.options.localServer.admin({ command: "pair" })) as {
      code?: unknown;
      expiresAt?: unknown;
    };
    if (typeof pairing?.code !== "string" || typeof pairing.expiresAt !== "string") {
      throw new WispBackendError("internal_error", "Wisps on this computer did not create a pairing code.");
    }
    return { code: pairing.code, expiresAt: pairing.expiresAt, link: pairingLink(exposure.publicOrigin, pairing.code) };
  }

  async revoke(request: unknown): Promise<RemoteAccessView> {
    const deviceId = (request as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 64) {
      throw invalid("The device is invalid.");
    }
    if (!this.settings.enabled) throw invalid("Turn on remote access to manage the devices paired with this computer.");
    const device = (await this.devices()).find(({ id }) => id === deviceId);
    if (!device) throw new WispBackendError("not_found", "That device is no longer paired.");
    // This app pairs with its own server by itself; revoking it would only disconnect this window.
    if (device.local) throw invalid("This computer's own app cannot be revoked.");
    await this.options.localServer.admin({ command: "revoke", deviceId });
    return this.view();
  }

  private async devices(): Promise<PairedDeviceView[]> {
    await this.options.localServer.ensureRunning();
    const devices = await this.options.localServer.admin({ command: "devices" });
    if (!Array.isArray(devices)) return [];
    return devices.map((device: PairedDeviceView) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      local: device.local,
    }));
  }
}

function parseSettings(value: unknown): RemoteAccessSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("The remote access settings are invalid.");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw invalid("The remote access settings are invalid.");
  const port = input.port ?? DEFAULT_REMOTE_ACCESS_PORT;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65_535) {
    throw invalid("The port must be between 1024 and 65535.");
  }
  const publicOrigin =
    input.publicOrigin === undefined || input.publicOrigin === null || input.publicOrigin === ""
      ? undefined
      : parsePublicOrigin(input.publicOrigin);
  if (input.enabled && !publicOrigin) {
    throw invalid("Enter the HTTPS address other devices reach this computer at, such as a Tailscale Serve address.");
  }
  return { enabled: input.enabled, port: port as number, ...(publicOrigin ? { publicOrigin } : {}) };
}

/** An HTTPS origin only: Wisps on this computer are never offered over plain HTTP. */
function parsePublicOrigin(value: unknown): string {
  const message = "Enter an HTTPS address without a path, such as https://laptop.tailnet-name.ts.net.";
  if (typeof value !== "string" || value.trim().length > 2048) throw invalid(message);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid(message);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw invalid(message);
  }
  return url.origin;
}
