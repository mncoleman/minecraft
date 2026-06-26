import { Database } from "bun:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { config, isAdminEmail, isAdminTelegram } from "./config.ts";

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  email         TEXT UNIQUE,
  password_hash TEXT,
  telegram_id   TEXT UNIQUE,
  google_sub    TEXT UNIQUE,
  google_email  TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS allowlist (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,   -- 'email' | 'telegram' | 'google' | 'username'
  value      TEXT NOT NULL,   -- normalized identity
  username   TEXT,            -- suggested in-game username
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, value)
);

-- Phase B: multi-world platform ---------------------------------------------
CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,            -- display name
  mv_world_name TEXT UNIQUE NOT NULL,     -- canonical Bukkit folder name (W in RCON cmds); ^[a-z0-9_-]{1,32}$
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  world_type    TEXT NOT NULL DEFAULT 'normal',
  seed          TEXT,
  source        TEXT,                     -- created | import | upload-zip
  status        TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at    INTEGER NOT NULL,
  UNIQUE(owner_user_id, name)
);

CREATE TABLE IF NOT EXISTS world_shares (
  id              TEXT PRIMARY KEY,
  world_id        TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  grantee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  UNIQUE(world_id, grantee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_world_shares_grantee ON world_shares(grantee_user_id);
CREATE INDEX IF NOT EXISTS idx_world_shares_world   ON world_shares(world_id);
CREATE INDEX IF NOT EXISTS idx_worlds_owner         ON worlds(owner_user_id);

-- Phase C: invites (only owner/admins create them) -------------------------
CREATE TABLE IF NOT EXISTS invites (
  id                 TEXT PRIMARY KEY,
  code               TEXT UNIQUE NOT NULL,
  email              TEXT,                -- optional target email (lowercased)
  suggested_username TEXT,
  role               TEXT NOT NULL DEFAULT 'user',   -- user | admin
  invited_by         TEXT NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked
  accepted_user_id   TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  accepted_at        INTEGER,
  expires_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_code   ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- Phase C: deferred hop destination (placed in this world on next join) ------
CREATE TABLE IF NOT EXISTS pending_destination (
  username     TEXT PRIMARY KEY,
  target_world TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_notes (
  world_id   TEXT PRIMARY KEY,
  body       TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_locations (
  username   TEXT PRIMARY KEY,
  world      TEXT NOT NULL,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  z          INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teleport_history (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  world      TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tphist_user ON teleport_history(user_id, created_at);

CREATE TABLE IF NOT EXISTS saved_locations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  world      TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savedloc_user ON saved_locations(user_id);

-- Single-use, expiring tokens for password reset, email verification, and email
-- change. The raw token is only ever in the emailed link; we store its SHA-256.
CREATE TABLE IF NOT EXISTS tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,       -- reset_password | verify_email | change_email
  token_hash TEXT NOT NULL,       -- sha256(raw token)
  new_value  TEXT,                -- change_email: the target email
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

-- Friends: an accepted friendship is ONE row with the pair stored ordered
-- (user_a < user_b) so the relationship is symmetric and can't be duplicated.
CREATE TABLE IF NOT EXISTS friendships (
  user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b);

-- Friend requests. to_user_id NULL = an open "friend link" anyone logged-in can
-- accept; otherwise it targets one user (and may be emailed to them). code is the
-- unguessable token in the accept link.
CREATE TABLE IF NOT EXISTS friend_requests (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | revoked
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_freq_to   ON friend_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_freq_from ON friend_requests(from_user_id, status);

-- Generic server-side key/value settings (e.g. the Telegram notification
-- toggle + getUpdates offset). Persists across redeploys via the data volume.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
`);

// ── migrations (idempotent; run on every boot, no-op once applied) ─────────────
function columnExists(table: string, col: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
}
if (!columnExists("users", "email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  // Grandfather existing accounts so the new flow never nags or locks them out.
  db.exec("UPDATE users SET email_verified = 1 WHERE email IS NOT NULL");
}

// teleport_history: store the teleport target's stable account id (when the
// teleport was "to a player") so the displayed name resolves live and stays
// correct after a rename, instead of being frozen into the label text.
if (!columnExists("teleport_history", "target_user_id")) {
  db.exec("ALTER TABLE teleport_history ADD COLUMN target_user_id TEXT");
  // Best-effort backfill: link existing "→ <name>" arrow labels to a user id so
  // old entries also become dynamic. Unmatched names keep their literal label.
  try {
    const rows = db.query("SELECT id, label FROM teleport_history WHERE target_user_id IS NULL AND label LIKE '→ %'").all() as Array<{ id: number; label: string }>;
    for (const r of rows) {
      const name = r.label.replace(/^→\s*/, "").trim();
      const u = db.query("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(name) as { id: string } | null;
      if (u) db.run("UPDATE teleport_history SET target_user_id = ? WHERE id = ?", [u.id, r.id]);
    }
  } catch { /* backfill is best-effort; never block boot */ }
}

// ── generic settings kv ────────────────────────────────────────────────────
export function getSetting(key: string): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r ? r.value : null;
}
export function setSetting(key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, value, Math.floor(Date.now() / 1000)],
  );
}

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  password_hash: string | null;
  telegram_id: string | null;
  google_sub: string | null;
  google_email: string | null;
  is_admin: number;
  email_verified: number;
  created_at: number;
  last_login_at: number | null;
}

export interface AllowEntry {
  id: string;
  kind: string;
  value: string;
  username: string | null;
  note: string | null;
  created_at: number;
}

type Resolved = { user: User } | { error: string };

const now = () => Math.floor(Date.now() / 1000);

// ── helpers ──────────────────────────────────────────────────────────────────

export function sanitizeUsername(raw: string): string {
  let u = (raw || "").replace(/[^A-Za-z0-9_]/g, "");
  if (u.length < 3) u = (u + "player").slice(0, 16);
  return u.slice(0, 16);
}

function usernameTaken(username: string): boolean {
  return !!db.query("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username);
}

/** Same as usernameTaken, but ignores a given user's own row (for renames). */
export function usernameTakenExcept(username: string, exceptUserId: string): boolean {
  return !!db.query("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?").get(username, exceptUserId);
}

function uniqueUsername(base: string): string {
  let u = sanitizeUsername(base);
  if (!usernameTaken(u)) return u;
  for (let i = 2; i < 1000; i++) {
    const cand = (u.slice(0, 16 - String(i).length) + i);
    if (!usernameTaken(cand)) return cand;
  }
  return sanitizeUsername(randomUUID().slice(0, 12));
}

function findAllow(kind: string, value: string): AllowEntry | null {
  return db
    .query("SELECT * FROM allowlist WHERE kind = ? AND value = ? COLLATE NOCASE")
    .get(kind, value) as AllowEntry | null;
}

function touchLogin(id: string): void {
  db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [now(), id]);
}

function getUser(id: string): User {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User;
}

// ── allowlist management (used by admin) ─────────────────────────────────────

export function listAllow(): AllowEntry[] {
  return db.query("SELECT * FROM allowlist ORDER BY created_at DESC").all() as AllowEntry[];
}

export function addAllow(kind: string, value: string, username?: string, note?: string): void {
  const norm = kind === "telegram" ? String(value).trim() : String(value).trim().toLowerCase();
  db.run(
    "INSERT OR REPLACE INTO allowlist (id, kind, value, username, note, created_at) VALUES (?,?,?,?,?,?)",
    [randomUUID(), kind, norm, username ? sanitizeUsername(username) : null, note ?? null, now()],
  );
}

export function removeAllow(id: string): void {
  db.run("DELETE FROM allowlist WHERE id = ?", [id]);
}

export function bootstrapAllowlist(): void {
  const count = (db.query("SELECT COUNT(*) AS n FROM allowlist").get() as { n: number }).n;
  if (count > 0 || !config.allowlistBootstrap) return;
  for (const entry of config.allowlistBootstrap.split(",")) {
    const [kind, value, username] = entry.split(":").map((s) => s.trim());
    if (!kind || !value) continue;
    try {
      addAllow(kind, value, username);
    } catch (e) {
      console.error("bootstrap allowlist entry failed:", entry, e);
    }
  }
  console.log(`Seeded ${listAllow().length} allowlist entries from ALLOWLIST env`);
}

// ── provider resolution ──────────────────────────────────────────────────────

export function resolveTelegramUser(p: { id: string; username?: string; firstName?: string }): Resolved {
  const existing = db.query("SELECT * FROM users WHERE telegram_id = ?").get(p.id) as User | null;
  if (existing) {
    if (isAdminTelegram(p.id) && !existing.is_admin) db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [existing.id]);
    touchLogin(existing.id);
    return { user: getUser(existing.id) };
  }
  const allow = findAllow("telegram", p.id) ?? (p.username ? findAllow("username", p.username) : null);
  if (!allow && !isAdminTelegram(p.id)) return { error: "not_allowed" };

  const id = randomUUID();
  const username = uniqueUsername(allow?.username || p.username || `tg${p.id}`);
  db.run(
    "INSERT INTO users (id, username, display_name, telegram_id, is_admin, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)",
    [id, username, p.firstName ?? p.username ?? username, p.id, isAdminTelegram(p.id) ? 1 : 0, now(), now()],
  );
  return { user: getUser(id) };
}

export function resolveGoogleUser(p: { sub: string; email: string; name?: string }): Resolved {
  const email = p.email.toLowerCase();
  const existing =
    (db.query("SELECT * FROM users WHERE google_sub = ?").get(p.sub) as User | null) ??
    (db.query("SELECT * FROM users WHERE email = ?").get(email) as User | null);
  if (existing) {
    // link google_sub if matched by email
    db.run("UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?", [p.sub, email, existing.id]);
    if (isAdminEmail(email) && !existing.is_admin) db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [existing.id]);
    touchLogin(existing.id);
    return { user: getUser(existing.id) };
  }
  const allow = findAllow("google", email) ?? findAllow("email", email);
  if (!allow && !isAdminEmail(email)) return { error: "not_allowed" };

  const id = randomUUID();
  const username = uniqueUsername(allow?.username || p.name || email.split("@")[0]);
  db.run(
    "INSERT INTO users (id, username, display_name, email, google_sub, google_email, is_admin, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, username, p.name ?? username, email, p.sub, email, isAdminEmail(email) ? 1 : 0, now(), now()],
  );
  return { user: getUser(id) };
}

// Email/password. Registration is closed: an email must be allowlisted. On first
// login for an allowlisted email with no password yet, the supplied password is
// set (invite/claim flow). Afterwards it is verified.
// Pin argon2id params so a Bun upgrade can't silently change cost. Verify reads
// params from the stored hash, so existing hashes keep working unchanged.
export function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

// ── user lookups + mutations (account management) ────────────────────────────

export function getUserById(id: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function getUserByEmail(email: string): User | null {
  return db.query("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim().toLowerCase()) as User | null;
}

export function emailInUse(email: string, exceptUserId?: string): boolean {
  const row = getUserByEmail(email);
  return !!row && row.id !== exceptUserId;
}

/** Apply a confirmed email change. Also keeps the allowlist entry in sync so the
 *  account still resolves on a future email login. Returns false if taken. */
export function setUserEmail(userId: string, email: string): boolean {
  const norm = email.trim().toLowerCase();
  if (emailInUse(norm, userId)) return false;
  db.run("UPDATE users SET email = ?, email_verified = 1 WHERE id = ?", [norm, userId]);
  const u = getUserById(userId);
  if (u) addAllow("email", norm, u.username);
  return true;
}

export function markEmailVerified(userId: string): void {
  db.run("UPDATE users SET email_verified = 1 WHERE id = ?", [userId]);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), userId]);
}

/** Change a user's in-game username and update every username-keyed row in one
 *  transaction. Worlds + shares are keyed by user_id and need no change here; the
 *  caller re-pushes the in-game (UUID-derived) grants separately. Returns the old
 *  and new username, or an { error } describing why the rename was rejected. */
export function renameUser(userId: string, rawNew: string): { oldUsername: string; newUsername: string } | { error: string } {
  const u = getUserById(userId);
  if (!u) return { error: "User not found." };
  const next = sanitizeUsername(rawNew);
  // sanitizeUsername pads names shorter than 3 chars, so compare against the raw
  // intent: reject if the cleaned input doesn't match what they typed in spirit.
  if ((rawNew || "").replace(/[^A-Za-z0-9_]/g, "").length < 3) {
    return { error: "Username must be at least 3 characters (letters, numbers, underscore)." };
  }
  if (next === u.username) return { error: "That is already your username." };
  if (usernameTakenExcept(next, userId)) return { error: "That username is already taken." };
  db.transaction(() => {
    db.run("UPDATE users SET username = ? WHERE id = ?", [next, userId]);
    db.run("UPDATE player_locations SET username = ? WHERE username = ? COLLATE NOCASE", [next, u.username]);
    db.run("UPDATE pending_destination SET username = ? WHERE username = ? COLLATE NOCASE", [next, u.username]);
    db.run("UPDATE allowlist SET value = ? WHERE kind = 'username' AND value = ? COLLATE NOCASE", [next, u.username]);
    db.run("UPDATE allowlist SET username = ? WHERE username = ? COLLATE NOCASE", [next, u.username]);
  })();
  return { oldUsername: u.username, newUsername: next };
}

export function ownedWorldCount(userId: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM worlds WHERE owner_user_id = ?").get(userId) as { n: number }).n;
}

/** Count of pending incoming friend requests for a username (for the nav dot).
 *  By username so the layout shell can call it without the user id; lives here
 *  (not friends.ts) to avoid a layout.ts <-> friends.ts import cycle. */
export function pendingFriendRequestCount(username: string): number {
  const u = db.query("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username) as { id: string } | null;
  if (!u) return 0;
  return (db.query("SELECT COUNT(*) AS n FROM friend_requests WHERE to_user_id = ? AND status = 'pending'").get(u.id) as { n: number }).n;
}

/** Hard-delete a user and every DB reference to them, in one transaction. The
 *  caller must enforce who-may-delete and that the user owns NO worlds first
 *  (worlds.owner_user_id has no cascade — deleting a world owner would throw).
 *  Allowlist entries for their identities are removed so they can't silently
 *  re-create the account on next login. Returns the username, or null if gone. */
export function deleteUser(userId: string): { username: string } | null {
  const u = getUserById(userId);
  if (!u) return null;
  db.transaction(() => {
    db.run("DELETE FROM invites WHERE invited_by = ? OR accepted_user_id = ?", [userId, userId]);
    db.run("DELETE FROM world_shares WHERE granted_by = ? OR grantee_user_id = ?", [userId, userId]);
    if (u.email) db.run("DELETE FROM allowlist WHERE kind = 'email' AND value = ? COLLATE NOCASE", [u.email]);
    if (u.google_email) db.run("DELETE FROM allowlist WHERE kind IN ('email','google') AND value = ? COLLATE NOCASE", [u.google_email]);
    if (u.telegram_id) db.run("DELETE FROM allowlist WHERE kind = 'telegram' AND value = ?", [u.telegram_id]);
    db.run("DELETE FROM allowlist WHERE kind = 'username' AND value = ? COLLATE NOCASE", [u.username]);
    db.run("DELETE FROM player_locations WHERE username = ? COLLATE NOCASE", [u.username]);
    db.run("DELETE FROM pending_destination WHERE username = ? COLLATE NOCASE", [u.username]);
    db.run("DELETE FROM teleport_history WHERE user_id = ?", [userId]);
    db.run("DELETE FROM saved_locations WHERE user_id = ?", [userId]);
    db.run("DELETE FROM tokens WHERE user_id = ?", [userId]);
    db.run("DELETE FROM users WHERE id = ?", [userId]);
  })();
  return { username: u.username };
}

// ── single-use tokens (reset / verify / change-email) ────────────────────────

export type TokenPurpose = "reset_password" | "verify_email" | "change_email";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Mint a token, store only its hash, return the raw value for the email link.
 *  Any prior unused token of the same purpose for this user is invalidated. */
export function createToken(userId: string, purpose: TokenPurpose, ttlSec: number, newValue?: string): string {
  db.run("UPDATE tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL", [now(), userId, purpose]);
  const raw = randomBytes(32).toString("hex");
  db.run(
    "INSERT INTO tokens (id, user_id, purpose, token_hash, new_value, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
    [randomUUID(), userId, purpose, sha256(raw), newValue ?? null, now(), now() + ttlSec],
  );
  return raw;
}

export interface TokenRow { userId: string; purpose: TokenPurpose; newValue: string | null }

/** Validate a token WITHOUT consuming it (for showing a reset form on GET). */
export function checkToken(raw: string, allowed: TokenPurpose[]): TokenRow | null {
  const row = db.query("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(raw)) as
    | { user_id: string; purpose: TokenPurpose; new_value: string | null; expires_at: number; used_at: number | null }
    | null;
  if (!row || row.used_at || now() > row.expires_at || !allowed.includes(row.purpose)) return null;
  return { userId: row.user_id, purpose: row.purpose, newValue: row.new_value };
}

/** Validate AND consume (single-use) a token. */
export function consumeToken(raw: string, allowed: TokenPurpose[]): TokenRow | null {
  const row = db.query("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(raw)) as
    | { id: string; user_id: string; purpose: TokenPurpose; new_value: string | null; expires_at: number; used_at: number | null }
    | null;
  if (!row || row.used_at || now() > row.expires_at || !allowed.includes(row.purpose)) return null;
  db.run("UPDATE tokens SET used_at = ? WHERE id = ?", [now(), row.id]);
  return { userId: row.user_id, purpose: row.purpose, newValue: row.new_value };
}

export async function resolveEmailLogin(email: string, password: string): Promise<Resolved> {
  email = email.toLowerCase();
  const existing = db.query("SELECT * FROM users WHERE email = ?").get(email) as User | null;

  if (existing) {
    if (!existing.password_hash) {
      // claim: set password now
      const hash = await hashPassword(password);
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, existing.id]);
      touchLogin(existing.id);
      return { user: getUser(existing.id) };
    }
    const ok = await Bun.password.verify(password, existing.password_hash);
    if (!ok) return { error: "bad_credentials" };
    if (isAdminEmail(email) && !existing.is_admin) db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [existing.id]);
    touchLogin(existing.id);
    return { user: getUser(existing.id) };
  }

  const allow = findAllow("email", email);
  if (!allow && !isAdminEmail(email)) return { error: "not_allowed" };

  const id = randomUUID();
  const username = uniqueUsername(allow?.username || email.split("@")[0]);
  const hash = await hashPassword(password);
  db.run(
    "INSERT INTO users (id, username, display_name, email, password_hash, is_admin, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, username, username, email, hash, isAdminEmail(email) ? 1 : 0, now(), now()],
  );
  return { user: getUser(id) };
}
