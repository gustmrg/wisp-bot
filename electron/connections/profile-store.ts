import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import { validateRemoteEndpoint } from "../../client/remote-backend-client.js";
import type { ConnectionProfile } from "../../shared/connections.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";

const local: ConnectionProfile = { id: "local", name: "This computer", kind: "local" };
const string = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const port = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
export function validateConnectionProfile(value: unknown): ConnectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid connection profile.");
  const profile = value as Record<string, unknown>;
  if (!string(profile.id, 80) || !/^[A-Za-z0-9_-]+$/.test(profile.id) || !string(profile.name, 100))
    throw new Error("A connection needs a valid ID and name.");
  const base = {
    id: profile.id,
    name: profile.name,
    ...(string(profile.expectedServerId, 100) ? { expectedServerId: profile.expectedServerId } : {}),
    ...(string(profile.lastConnectedAt, 50) ? { lastConnectedAt: profile.lastConnectedAt } : {}),
  };
  if (profile.kind === "local") {
    if (profile.id !== "local") throw new Error("Only the built-in local profile is allowed.");
    return local;
  }
  if (profile.id === "local") throw new Error("The built-in local profile cannot be replaced.");
  if (profile.kind === "https") {
    if (!string(profile.endpoint, 2048)) throw new Error("Provide the HTTPS origin of the server.");
    return { ...base, kind: "https", endpoint: validateRemoteEndpoint(profile.endpoint) };
  }
  if (
    profile.kind !== "ssh" ||
    !string(profile.host) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(profile.host) ||
    !port(profile.port) ||
    !port(profile.remotePort) ||
    !["openssh", "tailscale-ssh"].includes(String(profile.sshAuthMode))
  )
    throw new Error("Provide a valid SSH host, port and authentication mode.");
  if (
    profile.username !== undefined &&
    (!string(profile.username, 64) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(profile.username))
  )
    throw new Error("Invalid SSH user name.");
  if (
    profile.identityFile !== undefined &&
    (!string(profile.identityFile, 4096) || !path.isAbsolute(profile.identityFile))
  )
    throw new Error("Select an absolute path to your existing SSH key.");
  if (profile.sshAuthMode === "tailscale-ssh" && profile.port !== 22) throw new Error("Tailscale SSH uses port 22.");
  return {
    ...base,
    kind: "ssh",
    host: profile.host,
    username: profile.username as string | undefined,
    port: profile.port,
    remotePort: profile.remotePort,
    sshAuthMode: profile.sshAuthMode as "openssh" | "tailscale-ssh",
    identityFile: profile.identityFile as string | undefined,
  };
}

interface StoredProfiles {
  profiles: ConnectionProfile[];
  secrets: Record<string, string>;
}
export class ConnectionProfileStore {
  private data: StoredProfiles = { profiles: [local], secrets: {} };
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly encryption: EncryptionService,
  ) {}
  async load(): Promise<void> {
    try {
      const stored = JSON.parse(
        await readFile(path.join(this.directory, "connections.json"), "utf8"),
      ) as StoredProfiles;
      if (!Array.isArray(stored.profiles) || !stored.secrets || typeof stored.secrets !== "object")
        throw new Error("Invalid connection store.");
      this.data = {
        profiles: [local, ...stored.profiles.map(validateConnectionProfile).filter((p) => p.kind !== "local")],
        secrets: stored.secrets,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("The connection store could not be read. Restore its backup before continuing.");
    }
  }
  list(): ConnectionProfile[] {
    return structuredClone(this.data.profiles);
  }
  get(id: string): ConnectionProfile {
    const value = this.data.profiles.find((profile) => profile.id === id);
    if (!value) throw new Error("Connection profile not found.");
    return structuredClone(value);
  }
  async save(input: unknown): Promise<ConnectionProfile> {
    const profile = validateConnectionProfile(input);
    const previous = this.data.profiles.find((candidate) => candidate.id === profile.id);
    // A changed destination must never receive credentials belonging to the old endpoint.
    const destination = (p: ConnectionProfile): string =>
      p.kind === "https"
        ? p.endpoint
        : p.kind === "ssh"
          ? `${p.host}:${p.port}:${p.username ?? ""}:${p.remotePort}:${p.sshAuthMode}`
          : "local";
    if (previous && destination(previous) !== destination(profile)) {
      delete this.data.secrets[profile.id];
      delete profile.expectedServerId;
    }
    this.data.profiles = [...this.data.profiles.filter((candidate) => candidate.id !== profile.id), profile];
    await this.persist();
    return structuredClone(profile);
  }
  async delete(id: string): Promise<void> {
    if (id === "local") throw new Error("The local connection cannot be removed.");
    this.data.profiles = this.data.profiles.filter((profile) => profile.id !== id);
    delete this.data.secrets[id];
    await this.persist();
  }
  async credentials(id: string): Promise<DeviceCredentials | undefined> {
    const ciphertext = this.data.secrets[id];
    if (!ciphertext) return undefined;
    if (!this.encryption.isAvailable()) throw new Error("Unlock secure storage to use this connection.");
    try {
      return JSON.parse(this.encryption.decrypt(Buffer.from(ciphertext, "base64"))) as DeviceCredentials;
    } catch {
      throw new Error("The saved device credential could not be unlocked. Pair this device again.");
    }
  }
  async saveCredentials(id: string, credentials: DeviceCredentials | undefined): Promise<void> {
    if (!credentials) delete this.data.secrets[id];
    else {
      if (!this.encryption.isAvailable())
        throw new Error("Secure storage is unavailable. Unlock the operating system keychain before pairing.");
      this.data.secrets[id] = this.encryption.encrypt(JSON.stringify(credentials)).toString("base64");
    }
    await this.persist();
  }
  private async persist(): Promise<void> {
    const serialized = JSON.stringify(this.data);
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = path.join(this.directory, "connections.json");
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, serialized, { mode: 0o600 });
        await rename(temporary, target);
      });
    return this.writes;
  }
}
