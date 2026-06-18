import { randomUUID, createHash } from "node:crypto";
import { db, type User } from "./db.ts";
import { rcon, rconAll, stripColor } from "./rcon.ts";

/**
 * Offline-mode player UUID = Java's UUID.nameUUIDFromBytes("OfflinePlayer:"+name)
 * (MD5, version 3). MUST be used for WorldGuard region membership and LuckPerms:
 * on an internet-connected offline-mode server, passing a NAME makes WorldGuard
 * resolve the *online* Mojang UUID, which never matches the offline UUID the
 * player logs in with — so the grant silently does nothing. Passing the offline
 * UUID is deterministic and correct.
 */
export function offlineUuid(name: string): string {
  const h = createHash("md5").update("OfflinePlayer:" + name, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x30; // version 3
  h[8] = (h[8] & 0x3f) | 0x80; // IETF variant
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ── types ────────────────────────────────────────────────────────────────────
export interface World {
  id: string;
  name: string;
  mv_world_name: string;
  owner_user_id: string;
  world_type: string;
  seed: string | null;
  source: string | null;
  status: string;
  created_at: number;
}
export interface WorldShare {
  id: string;
  world_id: string;
  grantee_user_id: string;
  granted_by: string;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export function sanitizeWorldName(raw: string): string {
  return (raw || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

// ── DB layer ─────────────────────────────────────────────────────────────────
export function getWorld(id: string): World | null {
  return db.query("SELECT * FROM worlds WHERE id = ?").get(id) as World | null;
}
export function getWorldByMv(mv: string): World | null {
  return db.query("SELECT * FROM worlds WHERE mv_world_name = ?").get(mv) as World | null;
}
export function listAllWorlds(): World[] {
  return db.query("SELECT * FROM worlds ORDER BY created_at").all() as World[];
}
export function listWorldsOwnedBy(userId: string): World[] {
  return db.query("SELECT * FROM worlds WHERE owner_user_id = ? AND status='active' ORDER BY created_at").all(userId) as World[];
}
export function listWorldsSharedWith(userId: string): Array<World & { owner_username: string }> {
  return db
    .query(
      `SELECT w.*, u.username AS owner_username
         FROM world_shares s JOIN worlds w ON w.id = s.world_id JOIN users u ON u.id = w.owner_user_id
        WHERE s.grantee_user_id = ? AND w.status='active' ORDER BY w.created_at`,
    )
    .all(userId) as Array<World & { owner_username: string }>;
}
export function sharesForWorld(worldId: string): Array<{ grantee_user_id: string; username: string; created_at: number }> {
  return db
    .query(
      `SELECT s.grantee_user_id, u.username, s.created_at
         FROM world_shares s JOIN users u ON u.id = s.grantee_user_id
        WHERE s.world_id = ? ORDER BY u.username`,
    )
    .all(worldId) as Array<{ grantee_user_id: string; username: string; created_at: number }>;
}
export function insertWorld(w: Omit<World, "created_at">): void {
  db.run(
    "INSERT INTO worlds (id,name,mv_world_name,owner_user_id,world_type,seed,source,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [w.id, w.name, w.mv_world_name, w.owner_user_id, w.world_type, w.seed, w.source, w.status, now()],
  );
}

// ── Access bridge (RCON) ─────────────────────────────────────────────────────
// access == build. Two layers set together: Multiverse entry (LuckPerms node)
// + WorldGuard __global__ membership (build). Owner is added as region owner.
// NOTE: exact 1.12.2 syntax verified against WG 6.2.2 / MV 2.5.0 / LP 5.5.55.

/** One-time per-world setup at create/import. __global__ auto-instantiates on flag. */
export async function provisionWorld(mv: string, ownerUsername: string): Promise<string[]> {
  const o = offlineUuid(ownerUsername);
  return rconAll([
    `rg flag -w ${mv} __global__ passthrough deny`,   // build only for members/owners
    `rg addowner -w ${mv} __global__ ${o}`,           // owner can always build
    `lp user ${o} permission set multiverse.access.${mv} true`, // owner can enter
  ]);
}

/** Grant build access to a user in a world (entry + build). */
export async function grantBuild(username: string, mv: string): Promise<string[]> {
  const u = offlineUuid(username);
  return rconAll([
    `rg addmember -w ${mv} __global__ ${u}`,
    `lp user ${u} permission set multiverse.access.${mv} true`,
  ]);
}

/** Revoke build access (set false, not unset, for a deterministic deny). */
export async function revokeBuild(username: string, mv: string): Promise<string[]> {
  const u = offlineUuid(username);
  return rconAll([
    `rg removemember -w ${mv} __global__ ${u}`,
    `lp user ${u} permission set multiverse.access.${mv} false`,
  ]);
}

/** Teleport a (currently online) player to a world. */
export async function teleportTo(username: string, mv: string): Promise<string> {
  return rcon(`mvtp ${username} ${mv}`);
}

/** Read a world's seed from Multiverse (used for seed-map links). null if unparseable. */
export async function fetchWorldSeed(mv: string): Promise<string | null> {
  try {
    const out = stripColor(await rcon(`mv info ${mv}`));
    const m = out.match(/Seed:\s*(-?\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Remember where to drop a player on their next join (offline hop). */
export function setPendingDestination(username: string, mv: string, ttlSec = 600): void {
  db.run(
    "INSERT OR REPLACE INTO pending_destination (username, target_world, created_at, expires_at) VALUES (?,?,?,?)",
    [username, mv, now(), now() + ttlSec],
  );
}

// ── per-world shared notes ───────────────────────────────────────────────────
export interface WorldNote { world_id: string; body: string; updated_by: string | null; updated_at: number }
export function getNote(worldId: string): WorldNote | null {
  return db.query("SELECT * FROM world_notes WHERE world_id = ?").get(worldId) as WorldNote | null;
}
export function saveNote(worldId: string, body: string, updatedByUserId: string): void {
  db.run(
    `INSERT INTO world_notes (world_id, body, updated_by, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(world_id) DO UPDATE SET body=excluded.body, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [worldId, body, updatedByUserId, now()],
  );
}

// ── last-known player locations (for the command center "go to player") ───────
export interface PlayerLoc { username: string; world: string; x: number; y: number; z: number; updated_at: number }
export function upsertLocation(username: string, world: string, x: number, y: number, z: number): void {
  db.run(
    `INSERT INTO player_locations (username, world, x, y, z, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET world=excluded.world, x=excluded.x, y=excluded.y, z=excluded.z, updated_at=excluded.updated_at`,
    [username, world, x, y, z, now()],
  );
}
export function getLocation(username: string): PlayerLoc | null {
  return db.query("SELECT * FROM player_locations WHERE username = ? COLLATE NOCASE").get(username) as PlayerLoc | null;
}

// ── teleport history (last N the user jumped to) + saved locations ────────────
export interface TeleportEntry { id: number; world: string; x: number; y: number; z: number; label: string | null; created_at: number }
export interface SavedLocation { id: string; world: string; x: number; y: number; z: number; name: string; created_at: number }

export function recordTeleport(userId: string, world: string, x: number, y: number, z: number, label: string): void {
  db.run("INSERT INTO teleport_history (user_id, world, x, y, z, label, created_at) VALUES (?,?,?,?,?,?,?)", [userId, world, x, y, z, label, now()]);
  // keep only the 5 most recent per user, PER WORLD
  db.run(
    `DELETE FROM teleport_history WHERE user_id = ? AND world = ? AND id NOT IN (
       SELECT id FROM teleport_history WHERE user_id = ? AND world = ? ORDER BY id DESC LIMIT 5)`,
    [userId, world, userId, world],
  );
}
export function recentTeleports(userId: string, world: string): TeleportEntry[] {
  return db.query("SELECT id, world, x, y, z, label, created_at FROM teleport_history WHERE user_id = ? AND world = ? ORDER BY id DESC LIMIT 5").all(userId, world) as TeleportEntry[];
}
export function listSavedLocations(userId: string, world: string): SavedLocation[] {
  return db.query("SELECT id, world, x, y, z, name, created_at FROM saved_locations WHERE user_id = ? AND world = ? ORDER BY name COLLATE NOCASE").all(userId, world) as SavedLocation[];
}
export function saveLocation(userId: string, name: string, world: string, x: number, y: number, z: number): void {
  db.run("INSERT INTO saved_locations (id, user_id, world, x, y, z, name, created_at) VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), userId, world, x, y, z, name, now()]);
}
export function updateSavedLocation(userId: string, id: string, name: string, world: string, x: number, y: number, z: number): void {
  db.run("UPDATE saved_locations SET name=?, world=?, x=?, y=?, z=? WHERE id=? AND user_id=?", [name, world, x, y, z, id, userId]);
}
export function deleteSavedLocation(userId: string, id: string): void {
  db.run("DELETE FROM saved_locations WHERE id=? AND user_id=?", [id, userId]);
}

// ── high-level ops used by the API ───────────────────────────────────────────
export async function shareWorld(world: World, grantee: User, grantedByUserId: string): Promise<void> {
  db.run(
    "INSERT OR IGNORE INTO world_shares (id,world_id,grantee_user_id,granted_by,created_at) VALUES (?,?,?,?,?)",
    [randomUUID(), world.id, grantee.id, grantedByUserId, now()],
  );
  await grantBuild(grantee.username, world.mv_world_name);
}

export async function unshareWorld(world: World, grantee: User): Promise<void> {
  db.run("DELETE FROM world_shares WHERE world_id = ? AND grantee_user_id = ?", [world.id, grantee.id]);
  await revokeBuild(grantee.username, world.mv_world_name);
}

/** Seed the existing cliff build as a world owned by the server owner (once). */
export function bootstrapWorlds(): void {
  const ownerEmail = (process.env.ADMIN_EMAILS || "").split(",")[0].trim().toLowerCase();
  if (!ownerEmail) return;
  const owner = db.query("SELECT * FROM users WHERE email = ?").get(ownerEmail) as User | null;
  if (!owner) return; // owner hasn't logged in yet; seed on a later boot
  if (!getWorldByMv("cliffbuild")) {
    insertWorld({ id: randomUUID(), name: "Cliff Build", mv_world_name: "cliffbuild", owner_user_id: owner.id, world_type: "normal", seed: null, source: "import", status: "active" });
    console.log(`seeded world: cliffbuild (owner ${owner.username})`);
  }
}

/** Reconciler: re-push every active share's grant so the live server self-heals. */
export async function reconcile(): Promise<{ worlds: number; grants: number }> {
  const worlds = listAllWorlds().filter((w) => w.status === "active");
  let grants = 0;
  for (const w of worlds) {
    const owner = db.query("SELECT username FROM users WHERE id = ?").get(w.owner_user_id) as { username: string } | null;
    if (owner) await provisionWorld(w.mv_world_name, owner.username).catch(() => {});
    for (const s of sharesForWorld(w.id)) {
      await grantBuild(s.username, w.mv_world_name).catch(() => {});
      grants++;
    }
    // Backfill the seed once (for seed-map links); self-heals existing worlds.
    if (!w.seed) {
      const seed = await fetchWorldSeed(w.mv_world_name);
      if (seed) db.run("UPDATE worlds SET seed = ? WHERE id = ?", [seed, w.id]);
    }
  }
  return { worlds: worlds.length, grants };
}
