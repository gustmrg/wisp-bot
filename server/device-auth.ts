import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import type { DeviceCredentials } from "../shared/remote-protocol.js";
import { HttpError, unauthorized } from "./errors.js";
import type { ServerStore } from "./server-store.js";

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
// A refresh response can be lost after the server rotated the token. The
// previous token keeps working this long so the client can retry.
const ROTATION_GRACE_MS = 60_000;
const MAX_PAIRING_FAILURES = 10;
const PAIRING_FAILURE_WINDOW_MS = 60_000;
const LAST_SEEN_INTERVAL_MS = 60_000;
// No 0/O, 1/I/L, or U: codes are read off one screen and typed on another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 10;

export interface PairingCode {
  /** Shown once; only its hash is stored. */
  code: string;
  expiresAt: string;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Paired by the desktop app that started this server, on the same computer. */
  local: boolean;
}

interface DeviceRow {
  id: string;
  refresh_hash: string;
  refresh_expires_at: number;
  previous_refresh_hash: string | null;
  rotated_at: number | null;
}

// Codes from the desktop app that starts a local server; never typed by a person.
const LOCAL_PAIRING_TTL_MS = 60 * 60_000;

const normalize = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "");
const randomCode = (length: number): string => {
  let raw = "";
  for (let index = 0; index < length; index++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return raw;
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");

/**
 * Pairs devices with one-time codes and issues their credentials. Access
 * tokens live only in memory, so a restart makes every client refresh once;
 * refresh tokens are stored as hashes and rotate on every use.
 */
export class DeviceAuth {
  private readonly accessTokens = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly lastSeen = new Map<string, number>();
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private pairingFailures: number[] = [];

  constructor(
    private readonly store: ServerStore,
    private readonly now: () => number = Date.now,
  ) {}

  createPairingCode(): PairingCode {
    const raw = randomCode(CODE_LENGTH);
    const expiresAt = this.storeCode(raw, PAIRING_TTL_MS, false);
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Accepts a code handed over by the desktop app that started this server,
   * through a channel only that app can read. The device it pairs is local:
   * it may open folders and pickers on this computer for the server.
   */
  registerLocalPairingCode(code: string): void {
    this.storeCode(normalize(code), LOCAL_PAIRING_TTL_MS, true);
  }

  isLocal(deviceId: string): boolean {
    const row = this.store.database.prepare("SELECT local FROM devices WHERE id = ?").get(deviceId) as
      | { local: number }
      | undefined;
    return row?.local === 1;
  }

  private storeCode(raw: string, ttlMs: number, local: boolean): number {
    const expiresAt = this.now() + ttlMs;
    this.store.transaction(() => {
      this.store.database.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(this.now());
      this.store.database
        .prepare("INSERT INTO pairing_codes (hash, expires_at, local) VALUES (?, ?, ?)")
        .run(hash(raw), expiresAt, local ? 1 : 0);
    });
    return expiresAt;
  }

  pair(code: string, deviceName: string): DeviceCredentials {
    const now = this.now();
    this.pairingFailures = this.pairingFailures.filter((at) => at > now - PAIRING_FAILURE_WINDOW_MS);
    if (this.pairingFailures.length >= MAX_PAIRING_FAILURES) {
      throw new HttpError(429, "rate_limited", "Too many pairing attempts. Wait a minute and try again.", true);
    }
    const consumed = this.store.transaction(
      () =>
        this.store.database
          .prepare("DELETE FROM pairing_codes WHERE hash = ? AND expires_at > ? RETURNING local")
          .get(hash(normalize(code)), now) as { local: number } | undefined,
    );
    if (!consumed) {
      this.pairingFailures.push(now);
      throw unauthorized("The pairing code is invalid or expired.");
    }
    const deviceId = randomUUID();
    const refreshToken = token();
    this.store.database
      .prepare(
        "INSERT INTO devices (id, name, created_at, last_seen_at, refresh_hash, refresh_expires_at, local) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        deviceId,
        deviceName,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        hash(refreshToken),
        now + REFRESH_TTL_MS,
        consumed.local,
      );
    return this.issueAccess(deviceId, refreshToken);
  }

  refresh(refreshToken: string): DeviceCredentials {
    const now = this.now();
    const presented = hash(refreshToken);
    const row = this.store.database
      .prepare(
        "SELECT id, refresh_hash, refresh_expires_at, previous_refresh_hash, rotated_at FROM devices WHERE refresh_hash = ? OR previous_refresh_hash = ?",
      )
      .get(presented, presented) as DeviceRow | undefined;
    const current = row?.refresh_hash === presented && row.refresh_expires_at > now;
    const retried =
      row?.previous_refresh_hash === presented && row.rotated_at !== null && row.rotated_at + ROTATION_GRACE_MS > now;
    if (!row || !(current || retried)) throw unauthorized("The device session expired or was revoked. Pair again.");
    const next = token();
    // The previous token stays the one first replaced, so a retry window never extends itself.
    this.store.database
      .prepare(
        "UPDATE devices SET refresh_hash = ?, refresh_expires_at = ?, previous_refresh_hash = ?, rotated_at = ?, last_seen_at = ? WHERE id = ?",
      )
      .run(
        hash(next),
        now + REFRESH_TTL_MS,
        current ? row.refresh_hash : row.previous_refresh_hash,
        current ? now : row.rotated_at,
        new Date(now).toISOString(),
        row.id,
      );
    return this.issueAccess(row.id, next);
  }

  /** Resolves a bearer access token to its device, or throws `unauthorized`. */
  authenticate(accessToken: string): string {
    const entry = this.accessTokens.get(hash(accessToken));
    const now = this.now();
    if (!entry || entry.expiresAt <= now) throw unauthorized("The access token expired. Refresh the device session.");
    if ((this.lastSeen.get(entry.deviceId) ?? 0) + LAST_SEEN_INTERVAL_MS <= now) {
      this.lastSeen.set(entry.deviceId, now);
      this.store.database
        .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
        .run(new Date(now).toISOString(), entry.deviceId);
    }
    return entry.deviceId;
  }

  isActive(deviceId: string): boolean {
    return Boolean(this.store.database.prepare("SELECT 1 FROM devices WHERE id = ?").get(deviceId));
  }

  devices(): DeviceView[] {
    const rows = this.store.database
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, local FROM devices ORDER BY created_at",
      )
      .all() as unknown as Array<Omit<DeviceView, "local"> & { local: number }>;
    return rows.map((row) => ({ ...row, local: row.local === 1 }));
  }

  /** Removes the device and ends its sessions, including open event streams. Resolves false when unknown. */
  revoke(deviceId: string): boolean {
    const removed = this.store.database.prepare("DELETE FROM devices WHERE id = ?").run(deviceId).changes > 0;
    for (const [key, entry] of this.accessTokens) if (entry.deviceId === deviceId) this.accessTokens.delete(key);
    this.lastSeen.delete(deviceId);
    if (removed) for (const listener of this.revokeListeners) listener(deviceId);
    return removed;
  }

  onRevoke(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  private issueAccess(deviceId: string, refreshToken: string): DeviceCredentials {
    const now = this.now();
    for (const [key, entry] of this.accessTokens) if (entry.expiresAt <= now) this.accessTokens.delete(key);
    const accessToken = token();
    const expiresAt = now + ACCESS_TTL_MS;
    this.accessTokens.set(hash(accessToken), { deviceId, expiresAt });
    return {
      deviceId,
      serverId: this.store.serverId,
      accessToken,
      accessExpiresAt: new Date(expiresAt).toISOString(),
      refreshToken,
    };
  }
}
