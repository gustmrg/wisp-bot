import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../backend/atomic-file.js";
import { WispBackendError } from "../../backend/backend-error.js";
import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionProfile,
  type LocalConnectionProfile,
  type RemoteConnectionProfile,
} from "../../shared/connections.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";

const PROFILES_FILE = "connections.json";
const CREDENTIALS_FILE = "connection-credentials.json";
const MAX_PROFILES = 20;

export const LOCAL_PROFILE: LocalConnectionProfile = { id: LOCAL_CONNECTION_ID, kind: "local", name: "This computer" };

interface ProfilesFile {
  version: 1;
  activeId: string;
  profiles: RemoteConnectionProfile[];
}

interface CredentialsFile {
  version: 1;
  /** Profile ID to encrypted device credentials, base64. */
  credentials: Record<string, string>;
}

const invalid = (message = "The connection settings are invalid."): WispBackendError =>
  new WispBackendError("invalid_request", message);

function text(value: unknown, max: number): string {
  if (typeof value !== "string") throw invalid();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f\x7f]/.test(trimmed)) throw invalid();
  return trimmed;
}

function port(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw invalid("Ports must be between 1 and 65535.");
  }
  return value as number;
}

/**
 * Validates a remote profile from the renderer or from disk. SSH fields are
 * passed to OpenSSH as arguments, so they may not start with "-" or contain
 * anything beyond what host and user names use.
 */
export function parseRemoteProfile(value: unknown, id: string): RemoteConnectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const name = text(input.name, 80);
  if (input.kind === "ssh") {
    const host = text(input.host, 253);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:%-]*$/.test(host)) throw invalid("Enter a host name, IP address, or SSH alias.");
    const user = input.user === undefined || input.user === "" ? undefined : text(input.user, 64);
    if (user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) throw invalid("Enter a valid user name.");
    return {
      id,
      kind: "ssh",
      name,
      host,
      ...(user ? { user } : {}),
      ...(input.sshPort === undefined || input.sshPort === null ? {} : { sshPort: port(input.sshPort) }),
      serverPort: port(input.serverPort),
    };
  }
  if (input.kind === "url") {
    let url: URL;
    try {
      url = new URL(text(input.url, 2048));
    } catch {
      throw invalid("Enter the server's address, such as https://machine.tailnet-name.ts.net.");
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw invalid("Use an HTTPS address. Plain HTTP is allowed only on this computer.");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw invalid("Enter only the server's origin, without a path.");
    }
    return { id, kind: "url", name, url: url.origin };
  }
  throw invalid();
}

/**
 * Connection profiles and the active choice, in plain JSON, with each
 * profile's device credentials encrypted separately by the desktop keychain.
 * Without secure storage, credentials last until the app quits.
 */
export class ConnectionStore {
  private profiles: RemoteConnectionProfile[] = [];
  private activeId = LOCAL_CONNECTION_ID;
  private credentials = new Map<string, DeviceCredentials>();
  private writes = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly encryption: EncryptionService,
  ) {}

  get secureStorageAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  async load(): Promise<void> {
    const profiles = await readJson<ProfilesFile>(path.join(this.directory, PROFILES_FILE));
    if (profiles?.version === 1 && Array.isArray(profiles.profiles)) {
      for (const candidate of profiles.profiles.slice(0, MAX_PROFILES)) {
        try {
          const id = text((candidate as { id?: unknown }).id, 64);
          this.profiles.push(parseRemoteProfile(candidate, id));
        } catch {
          // Skip a profile edited into an invalid shape; the others still load.
        }
      }
      if (this.get(profiles.activeId)) this.activeId = profiles.activeId;
    }
    const stored = await readJson<CredentialsFile>(path.join(this.directory, CREDENTIALS_FILE));
    if (stored?.version === 1 && this.encryption.isAvailable()) {
      for (const [id, sealed] of Object.entries(stored.credentials ?? {})) {
        if (!this.get(id) || typeof sealed !== "string") continue;
        try {
          this.credentials.set(id, JSON.parse(this.encryption.decrypt(Buffer.from(sealed, "base64"))));
        } catch {
          // Unreadable after a keychain change: this device pairs again.
        }
      }
    }
  }

  list(): ConnectionProfile[] {
    return [LOCAL_PROFILE, ...this.profiles];
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  get active(): ConnectionProfile {
    return this.get(this.activeId) ?? LOCAL_PROFILE;
  }

  async setActive(id: string): Promise<void> {
    if (!this.get(id)) throw new WispBackendError("not_found", "That connection no longer exists.");
    this.activeId = id;
    await this.persistProfiles();
  }

  async save(request: unknown): Promise<RemoteConnectionProfile> {
    const requestedId = (request as { id?: unknown } | null)?.id;
    const existing = typeof requestedId === "string" ? this.profiles.find(({ id }) => id === requestedId) : undefined;
    if (requestedId !== undefined && !existing)
      throw new WispBackendError("not_found", "That connection no longer exists.");
    if (!existing && this.profiles.length >= MAX_PROFILES) throw invalid("Remove a connection before adding another.");
    const profile = parseRemoteProfile(request, existing?.id ?? randomUUID());
    if (existing) {
      this.profiles = this.profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate));
      // A different address may be a different server: pair again.
      if (addressOf(existing) !== addressOf(profile)) await this.saveCredentials(profile.id, undefined);
    } else {
      this.profiles.push(profile);
    }
    await this.persistProfiles();
    return profile;
  }

  async remove(id: string): Promise<void> {
    if (!this.profiles.some((profile) => profile.id === id)) {
      throw new WispBackendError("not_found", "That connection no longer exists.");
    }
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    if (this.activeId === id) this.activeId = LOCAL_CONNECTION_ID;
    this.credentials.delete(id);
    await this.persistProfiles();
    await this.persistCredentials();
  }

  loadCredentials(id: string): DeviceCredentials | undefined {
    return this.credentials.get(id);
  }

  async saveCredentials(id: string, credentials: DeviceCredentials | undefined): Promise<void> {
    if (credentials) this.credentials.set(id, credentials);
    else this.credentials.delete(id);
    await this.persistCredentials();
  }

  /** Waits for queued writes, e.g. before quitting. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persistProfiles(): Promise<void> {
    const file: ProfilesFile = { version: 1, activeId: this.activeId, profiles: this.profiles };
    return this.enqueue(path.join(this.directory, PROFILES_FILE), `${JSON.stringify(file, null, 2)}\n`);
  }

  private persistCredentials(): Promise<void> {
    if (!this.encryption.isAvailable()) return Promise.resolve();
    const credentials: Record<string, string> = {};
    for (const [id, value] of this.credentials) {
      credentials[id] = this.encryption.encrypt(JSON.stringify(value)).toString("base64");
    }
    const file: CredentialsFile = { version: 1, credentials };
    return this.enqueue(path.join(this.directory, CREDENTIALS_FILE), `${JSON.stringify(file)}\n`);
  }

  /** Writes in order, so a slow earlier write never lands after a later one. */
  private enqueue(file: string, contents: string): Promise<void> {
    const write = this.writes.then(() => writeFileAtomically(file, contents));
    this.writes = write.catch(() => undefined);
    return write;
  }
}

function addressOf(profile: RemoteConnectionProfile): string {
  return profile.kind === "ssh"
    ? `${profile.user ?? ""}@${profile.host}:${profile.sshPort ?? ""}:${profile.serverPort}`
    : profile.url;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
