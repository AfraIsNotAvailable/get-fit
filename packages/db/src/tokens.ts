/** Api tokens, devices and one-shot pairing codes.
 *
 * Tokens are 256-bit random strings and only their SHA-256 is stored: a leaked
 * database cannot be replayed. That is enough here because the token has full
 * entropy — no dictionary, no user-chosen password to stretch.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Db } from "./db.js";

export interface Device {
  deviceId: string;
  tokenId: string;
  name: string;
  platform: string;
  model: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  pushToken: string | null;
}

export interface IssuedToken {
  deviceId: string;
  tokenId: string;
  token: string;
  name: string;
  platform: string;
  expiresAt: string;
}

const stamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `gf_${randomBytes(32).toString("base64url")}`;
}

export function newPairingCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

const TOKEN_TTL_DAYS = 365;

export function issueToken(
  db: Db,
  options: { name: string; platform?: string; model?: string | null; now?: Date },
): IssuedToken {
  const now = options.now ?? new Date();
  const created = stamp(now);
  const expires = stamp(new Date(now.getTime() + TOKEN_TTL_DAYS * 86_400_000));
  const tokenId = randomBytes(8).toString("hex");
  const deviceId = randomBytes(8).toString("hex");
  const token = newToken();

  db.prepare(
    "INSERT INTO api_tokens (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(tokenId, options.name, hashToken(token), created, expires);
  db.prepare(
    "INSERT INTO devices (id, token_id, platform, name, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(deviceId, tokenId, options.platform ?? "cli", options.name, options.model ?? null, created);

  return {
    deviceId, tokenId, token, name: options.name,
    platform: options.platform ?? "cli", expiresAt: expires,
  };
}

export function createPairingCode(
  db: Db,
  options: { name: string; platform?: string; model?: string | null; ttlSeconds?: number; now?: Date },
): { code: string; expiresAt: string } {
  const now = options.now ?? new Date();
  const ttl = Math.max(60, Math.min(3600, options.ttlSeconds ?? 300));
  const expiresAt = stamp(new Date(now.getTime() + ttl * 1000));
  const code = newPairingCode();
  db.prepare(
    "INSERT OR REPLACE INTO pairing_codes (code_hash, name, platform, model, created_at, expires_at)"
      + " VALUES (?, ?, ?, ?, ?, ?)",
  ).run(hashToken(code), options.name, options.platform ?? "android", options.model ?? null,
    stamp(now), expiresAt);
  return { code, expiresAt };
}

/** Single use: a code that was already exchanged is gone, whatever else happens. */
export function consumePairingCode(
  db: Db,
  code: string,
  deviceName: string,
  platform: string,
  model: string | null,
  now: Date,
): IssuedToken | null {
  const row = db.prepare(
    "SELECT * FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
  ).get(hashToken(code), stamp(now)) as {
    name: string; platform: string; model: string | null;
  } | undefined;
  if (!row) return null;
  db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?")
    .run(stamp(now), hashToken(code));
  return issueToken(db, {
    name: deviceName || row.name,
    platform,
    model: model ?? row.model,
    now,
  });
}

export function findDeviceByToken(db: Db, token: string, now: Date, touch = true): Device | null {
  const row = db.prepare(
    "SELECT t.id AS token_id, t.name, t.expires_at, t.revoked_at, d.id AS device_id,"
      + " d.platform, d.model, d.created_at, d.last_seen_at, d.push_token"
      + " FROM api_tokens t LEFT JOIN devices d ON d.token_id = t.id"
      + " WHERE t.token_hash = ?",
  ).get(hashToken(token)) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && String(row.expires_at) < stamp(now)) return null;
  if (touch) {
    try {
      db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .run(stamp(now), String(row.token_id));
      if (row.device_id) {
        db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
          .run(stamp(now), String(row.device_id));
      }
    } catch {
      // read-only mode (the shadow run) must still authenticate
    }
  }
  return {
    deviceId: String(row.device_id ?? ""),
    tokenId: String(row.token_id),
    name: String(row.name),
    platform: String(row.platform ?? "cli"),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    createdAt: String(row.created_at ?? ""),
    lastUsedAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : String(row.last_seen_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
    pushToken: row.push_token === null || row.push_token === undefined ? null : String(row.push_token),
  };
}

export function revokeToken(db: Db, tokenId: string, now: Date): boolean {
  const result = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(stamp(now), tokenId);
  return Number(result.changes) > 0;
}

export function listTokens(db: Db): {
  tokenId: string; name: string; platform: string; createdAt: string;
  lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
}[] {
  const rows = db.prepare(
    "SELECT t.id, t.name, t.created_at, t.expires_at, t.revoked_at, t.last_used_at,"
      + " COALESCE(d.platform, 'cli') platform FROM api_tokens t"
      + " LEFT JOIN devices d ON d.token_id = t.id ORDER BY t.created_at",
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    tokenId: String(r.id),
    name: String(r.name),
    platform: String(r.platform),
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
  }));
}
