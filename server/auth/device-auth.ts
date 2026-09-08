import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { ServerDatabase } from "../storage/database.js";
import { HttpError } from "../errors.js";

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 86_400_000;
const ROTATION_GRACE_MS = 30_000;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");

export interface DeviceCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  deviceId: string;
  serverId: string;
  csrfToken: string;
}
export interface DevicePrincipal {
  deviceId: string;
  ownerId: string;
  csrfToken: string;
  expiresAt: string;
}

export class DeviceAuth {
  private readonly revokedListeners = new Set<(deviceId: string) => void>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  constructor(
    private readonly database: ServerDatabase,
    private readonly now: () => number = Date.now,
  ) {}
  createPairingCode(): { code: string; expiresAt: string } {
    const code = secret();
    const expiresAt = this.now() + 120_000;
    this.database.transaction(() => {
      this.database.sql.prepare("DELETE FROM pairing WHERE expires_at<?").run(this.now());
      this.database.sql.prepare("INSERT INTO pairing(hash,expires_at) VALUES (?,?)").run(hash(code), expiresAt);
    });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  pair(code: string, deviceName: string, remoteAddress: string): DeviceCredentials {
    this.limit(remoteAddress);
    return this.database.transaction(() => {
      const found = this.database.sql
        .prepare("DELETE FROM pairing WHERE hash=? AND expires_at>? RETURNING hash")
        .get(hash(code), this.now());
      if (!found) throw new HttpError(401, "unauthorized", "The pairing code is invalid or expired.");
      const deviceId = randomUUID();
      this.database.sql
        .prepare("INSERT INTO devices(id,name,created_at) VALUES (?,?,?)")
        .run(deviceId, deviceName, new Date(this.now()).toISOString());
      return this.issue(deviceId);
    });
  }
  authenticate(token: string): DevicePrincipal {
    if (token.length > 256) throw this.unauthorized();
    const row = this.database.sql
      .prepare(
        "SELECT t.device_id,t.csrf,t.expires_at FROM tokens t JOIN devices d ON d.id=t.device_id WHERE t.hash=? AND t.kind='access' AND t.expires_at>? AND d.revoked=0",
      )
      .get(hash(token), this.now());
    if (!row) throw this.unauthorized();
    return {
      deviceId: row.device_id as string,
      ownerId: this.database.ownerId,
      csrfToken: row.csrf as string,
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
    };
  }
  refresh(refreshToken: string): DeviceCredentials {
    if (refreshToken.length > 256) throw this.unauthorized();
    const tokenHash = hash(refreshToken);
    const row = this.database.sql
      .prepare(
        "SELECT t.device_id,t.used_at FROM tokens t JOIN devices d ON d.id=t.device_id WHERE t.hash=? AND t.kind='refresh' AND t.expires_at>? AND d.revoked=0",
      )
      .get(tokenHash, this.now());
    if (!row) throw this.unauthorized();
    if (row.used_at !== null) {
      if (Number(row.used_at) + ROTATION_GRACE_MS > this.now())
        return this.credentials(row.device_id as string, Number(row.used_at), refreshToken);
      throw this.unauthorized();
    }
    return this.database.transaction(() => {
      const issuedAt = this.now();
      const claimed = this.database.sql
        .prepare("UPDATE tokens SET used_at=? WHERE hash=? AND used_at IS NULL RETURNING hash")
        .get(issuedAt, tokenHash);
      if (!claimed) throw this.unauthorized();
      return this.issue(row.device_id as string, issuedAt, refreshToken);
    });
  }
  authenticateRefresh(token: string): DevicePrincipal {
    const row = this.database.sql
      .prepare(
        "SELECT t.device_id,t.csrf,t.expires_at FROM tokens t JOIN devices d ON d.id=t.device_id WHERE t.hash=? AND t.kind='refresh' AND t.expires_at>? AND d.revoked=0",
      )
      .get(hash(token), this.now());
    if (!row) throw this.unauthorized();
    return {
      deviceId: row.device_id as string,
      ownerId: this.database.ownerId,
      csrfToken: row.csrf as string,
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
    };
  }
  devices(): unknown[] {
    return this.database.sql
      .prepare("SELECT id,name,created_at AS createdAt FROM devices WHERE revoked=0 ORDER BY created_at")
      .all();
  }
  revoke(deviceId: string): void {
    this.database.transaction(() => {
      this.database.sql.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(deviceId);
      this.database.sql.prepare("DELETE FROM tokens WHERE device_id=?").run(deviceId);
      this.database.appendEvent("devices_changed", {});
    });
    for (const listener of this.revokedListeners) listener(deviceId);
  }
  onRevoke(listener: (deviceId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }
  private credentials(deviceId: string, issuedAt: number, seed?: string): DeviceCredentials {
    // Reconstruct the same rotation response across a process restart during the
    // short retry grace period, without persisting plaintext refresh credentials.
    const derive = (kind: string): string =>
      seed
        ? createHmac("sha256", seed)
            .update(`wisp-rotation-v1:${this.database.serverId}:${deviceId}:${issuedAt}:${kind}`)
            .digest("base64url")
        : secret();
    return {
      accessToken: derive("access"),
      refreshToken: derive("refresh"),
      csrfToken: derive("csrf"),
      deviceId,
      serverId: this.database.serverId,
      expiresAt: new Date(issuedAt + ACCESS_MS).toISOString(),
    };
  }
  private issue(deviceId: string, issuedAt = this.now(), seed?: string): DeviceCredentials {
    const credentials = this.credentials(deviceId, issuedAt, seed);
    const { accessToken, refreshToken, csrfToken } = credentials;
    this.database.sql.prepare("DELETE FROM tokens WHERE expires_at<?").run(this.now());
    const insert = this.database.sql.prepare(
      "INSERT INTO tokens(hash,device_id,kind,expires_at,csrf) VALUES (?,?,?,?,?)",
    );
    insert.run(hash(accessToken), deviceId, "access", issuedAt + ACCESS_MS, csrfToken);
    insert.run(hash(refreshToken), deviceId, "refresh", issuedAt + REFRESH_MS, csrfToken);
    return credentials;
  }
  private limit(address: string): void {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.expires < now) this.attempts.delete(key);
    const value = this.attempts.get(address) ?? { count: 0, expires: now + 60_000 };
    value.count++;
    this.attempts.set(address, value);
    if (value.count > 10 || this.attempts.size > 10_000)
      throw new HttpError(429, "rate_limited", "Too many pairing attempts. Try again later.", true);
  }
  private unauthorized(): HttpError {
    return new HttpError(401, "unauthorized", "The device session expired or was revoked.");
  }
}
