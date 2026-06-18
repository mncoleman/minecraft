import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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
`);

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
