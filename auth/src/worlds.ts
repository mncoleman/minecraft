import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { $ } from "bun";
import { db, type User } from "./db.ts";
import { rcon, rconAll, stripColor } from "./rcon.ts";
import { SERVERS, enabledServers, DEFAULT_SERVER, type ServerId } from "./servers.ts";

// Each server's /data is bind-mounted into mc-auth (GAMEDATA_DIR for 1.8,
// GAMEDATA26_DIR for 26) so we can read live world state the RCON control plane
// doesn't cleanly expose.
const gamedata = (srv: ServerId) => SERVERS[srv].gamedataDir;

/** Read a world's difficulty + spawn. 1.8 (Multiverse 2.5): parsed straight from
 *  worlds.yml (the source of truth `mvm set` writes to). 26 (Multiverse 5): from
 *  `mv info` over RCON. Used to show the real difficulty in the panel and get
 *  spawn coords for an exact-teleport fallback. Nulls if unreadable. */
export async function readMvWorld(mv: string, srv: ServerId = DEFAULT_SERVER): Promise<{ difficulty: string | null; spawn: { x: number; y: number; z: number } | null }> {
  if (SERVERS[srv].modern) {
    try {
      const out = stripColor(await rcon(`mv info ${mv} --page 1`, 5000, srv));
      const d = out.match(/Difficulty:\s*([A-Za-z]+)/i);
      const sp = out.match(/Spawn Location:\s*X:\s*(-?[\d.]+)\s*Y:\s*(-?[\d.]+)\s*Z:\s*(-?[\d.]+)/i);
      return {
        difficulty: d ? d[1].toLowerCase() : null,
        spawn: sp ? { x: parseFloat(sp[1]), y: parseFloat(sp[2]), z: parseFloat(sp[3]) } : null,
      };
    } catch {
      return { difficulty: null, spawn: null };
    }
  }
  return readMvWorldYml(mv);
}
function readMvWorldYml(mv: string): { difficulty: string | null; spawn: { x: number; y: number; z: number } | null } {
  try {
    const lines = readFileSync(`${gamedata("18")}/plugins/Multiverse-Core/worlds.yml`, "utf8").split("\n");
    let inWorld = false, inSpawn = false;
    let difficulty: string | null = null;
    let x: number | null = null, y: number | null = null, z: number | null = null;
    for (const line of lines) {
      const worldKey = line.match(/^  (\S+):\s*$/); // 2-space indent = a world name
      if (worldKey) { inWorld = worldKey[1] === mv; inSpawn = false; continue; }
      if (!inWorld) continue;
      if (/^    spawnLocation:/.test(line)) { inSpawn = true; continue; }
      const diff = line.match(/^    difficulty:\s*'?([A-Za-z]+)'?/);
      if (diff) difficulty = diff[1];
      if (/^    \S/.test(line)) inSpawn = false; // any other 4-space key ends the spawn block
      if (inSpawn) {
        const m = line.match(/^      (x|y|z):\s*(-?[\d.]+)/);
        if (m) { const v = parseFloat(m[2]); if (m[1] === "x") x = v; else if (m[1] === "y") y = v; else z = v; }
      }
    }
    return { difficulty, spawn: (x != null && y != null && z != null) ? { x, y, z } : null };
  } catch {
    return { difficulty: null, spawn: null };
  }
}

/**
 * Carry a player's saved character data from their OLD offline UUID to the NEW
 * one after a username change. Inventory, ender chest, position, health, XP, and
 * gamemode live in <world>/playerdata/<uuid>.dat (+ .dat_old); achievements and
 * stats in <world>/{advancements,stats}/<uuid>.json. We scan every world folder
 * (this server keeps one global playerdata in the main world, but per-world is
 * handled the same way) and rename each old-UUID file to the new UUID. rename
 * preserves the file's owner/inode (uid 1001), so no chown is needed, and only
 * works on the same filesystem — the /gamedata bind mount is one device.
 *
 * The caller MUST ensure the player is offline first (a disconnect flushes their
 * live data to the OLD .dat); transferInGameIdentity kicks + waits before this.
 */
export function transferPlayerData(oldUsername: string, newUsername: string, srv: ServerId = DEFAULT_SERVER): { moved: number; worlds: string[] } {
  const GAMEDATA_DIR = gamedata(srv);
  const oldU = offlineUuid(oldUsername);
  const newU = offlineUuid(newUsername);
  if (oldU === newU) return { moved: 0, worlds: [] };
  // subfolder -> file extensions that are keyed by <uuid>
  // 1.12: <world>/{playerdata,stats,advancements}. 26.x moved them under
  // <world>/players/{data,stats,advancements} (one global set in "world").
  const kinds: Array<{ sub: string; exts: string[] }> = [
    { sub: "playerdata", exts: [".dat", ".dat_old"] },
    { sub: "stats", exts: [".json"] },
    { sub: "advancements", exts: [".json"] },
    { sub: "players/data", exts: [".dat", ".dat_old"] },
    { sub: "players/stats", exts: [".json"] },
    { sub: "players/advancements", exts: [".json"] },
  ];
  let worldDirs: string[];
  try {
    worldDirs = readdirSync(GAMEDATA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { moved: 0, worlds: [] };
  }
  let moved = 0;
  const touched: string[] = [];
  for (const world of worldDirs) {
    for (const { sub, exts } of kinds) {
      const dir = `${GAMEDATA_DIR}/${world}/${sub}`;
      if (!existsSync(dir)) continue;
      for (const ext of exts) {
        const src = `${dir}/${oldU}${ext}`;
        const dst = `${dir}/${newU}${ext}`;
        if (!existsSync(src)) continue;
        try {
          // A pre-existing target would be an orphan from a previously-deleted
          // user who once held this name; preserve it rather than clobber.
          if (existsSync(dst)) renameSync(dst, `${dst}.pre-rename-${Math.floor(Date.now() / 1000)}`);
          renameSync(src, dst);
          moved++;
          if (!touched.includes(world)) touched.push(world);
        } catch { /* best-effort per file */ }
      }
    }
  }
  return { moved, worlds: touched };
}

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
  server: ServerId;
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
export function getWorldByMv(mv: string, srv: ServerId): World | null {
  return db.query("SELECT * FROM worlds WHERE mv_world_name = ? AND server = ?").get(mv, srv) as World | null;
}
export function listAllWorlds(): World[] {
  return db.query("SELECT * FROM worlds ORDER BY created_at").all() as World[];
}
export function listWorldsOwnedBy(userId: string): World[] {
  return db.query("SELECT * FROM worlds WHERE owner_user_id = ? AND status='active' AND mv_world_name <> 'world' ORDER BY created_at").all(userId) as World[];
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
    "INSERT INTO worlds (id,name,mv_world_name,owner_user_id,world_type,seed,source,status,created_at,server) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [w.id, w.name, w.mv_world_name, w.owner_user_id, w.world_type, w.seed, w.source, w.status, now(), w.server],
  );
}

// ── Access bridge (RCON) ─────────────────────────────────────────────────────
// access == build. Two layers set together: Multiverse entry (LuckPerms node)
// + WorldGuard __global__ membership (build). Owner is added as region owner.
// NOTE: exact 1.12.2 syntax verified against WG 6.2.2 / MV 2.5.0 / LP 5.5.55.

// Op-equivalent command nodes granted to a world OWNER, scoped to that world via
// LuckPerms world context (active only while they stand in their own world — NOT
// global /op). Deliberately EXCLUDES anything server-wide (stop, op/deop, ban,
// kick, whitelist, save-*, reload, and Multiverse/WorldGuard/LuckPerms admin).
//
// World context gates WHERE a command may RUN, not which entities it can target;
// some vanilla commands resolve targets globally. A security review therefore
// DROPPED the commands whose effect can reach players in OTHER worlds from the
// owner's world: kill, clear, effect, tp, teleport (the panel already performs
// all equivalent teleports via RCON, so no in-game grant is needed for them).
// time/weather/gamerule/difficulty/setworldspawn/summon are world-local. The
// remaining player-targeting ones (gamemode/give/xp/enchant) are reversible/benign
// and accepted as a documented residual on this small, trusted, private server.
const OWNER_CMD_NODES = [
  "gamemode", "give", "xp", "enchant",
  "time", "weather", "gamerule", "difficulty", "setworldspawn", "summon",
] as const;

function ownerCommandGrants(uuid: string, mv: string): string[] {
  return OWNER_CMD_NODES.map((n) => `lp user ${uuid} permission set minecraft.command.${n} true world=${mv}`);
}

// The shared lobby is registered in the DB (so it shows on the Worlds page with
// Notes / Hop), but it is OPEN: everyone may enter and build there. It must never
// be provisioned like a private world — `passthrough deny` + owner-only entry
// would lock every other player out of building in the world they spawn in.
// Every grant/revoke helper below is a no-op for it.
export const LOBBY_MV = "world";
export function isLobby(mv: string): boolean { return mv === LOBBY_MV; }

/** Usernames of panel admins — they may enter (view) every world in-game. */
function adminUsernames(): string[] {
  return (db.query("SELECT username FROM users WHERE is_admin = 1").all() as Array<{ username: string }>).map((r) => r.username);
}

function activePrivateWorlds(): World[] {
  return (db.query("SELECT * FROM worlds WHERE status='active'").all() as World[]).filter((w) => !isLobby(w.mv_world_name));
}

/** Give an admin entry (view) to every private world. Call on promote/rename. */
export async function grantAdminEntry(username: string): Promise<string[]> {
  const u = offlineUuid(username);
  const out: string[] = [];
  for (const srv of enabledServers()) {
    out.push(...await rconAll(activePrivateWorlds().filter((w) => w.server === srv)
      .map((w) => `lp user ${u} permission set multiverse.access.${w.mv_world_name} true`), srv));
  }
  return out;
}

/** Remove the admin-entry grant from every world this account neither owns nor
 *  is shared on. Call on demote/delete, and for the OLD name on rename. */
export async function revokeAdminEntry(username: string, userId: string): Promise<string[]> {
  const u = offlineUuid(username);
  const keep = new Set((db.query("SELECT world_id FROM world_shares WHERE grantee_user_id = ?").all(userId) as Array<{ world_id: string }>).map((r) => r.world_id));
  const out: string[] = [];
  for (const srv of enabledServers()) {
    out.push(...await rconAll(activePrivateWorlds()
      .filter((w) => w.server === srv && w.owner_user_id !== userId && !keep.has(w.id))
      .map((w) => `lp user ${u} permission unset multiverse.access.${w.mv_world_name}`), srv));
  }
  return out;
}

/** One-time per-world setup at create/import. __global__ auto-instantiates on flag. */
export async function provisionWorld(mv: string, ownerUsername: string, srv: ServerId): Promise<string[]> {
  if (isLobby(mv)) return [];
  const o = offlineUuid(ownerUsername);
  return rconAll([
    // Admins can ENTER every world (to view members' builds). Entry only: no
    // WorldGuard membership, so they can't build there unless shared.
    ...adminUsernames().map((a) => `lp user ${offlineUuid(a)} permission set multiverse.access.${mv} true`),
    `rg flag -w ${mv} __global__ passthrough deny`,   // build only for members/owners
    `rg addowner -w ${mv} __global__ ${o}`,           // owner can always build
    `lp user ${o} permission set multiverse.access.${mv} true`, // owner can enter
    ...ownerCommandGrants(o, mv),                     // world-scoped op-like commands
  ], srv);
}

/** Strip a (previous) owner's world-scoped op command nodes (rename/transfer). */
export async function revokeOwnerCommands(mv: string, ownerUsername: string, srv: ServerId): Promise<string[]> {
  if (isLobby(mv)) return [];
  const o = offlineUuid(ownerUsername);
  return rconAll(OWNER_CMD_NODES.map((n) => `lp user ${o} permission unset minecraft.command.${n} world=${mv}`), srv);
}

/** Grant build access to a user in a world (entry + build). */
export async function grantBuild(username: string, mv: string, srv: ServerId): Promise<string[]> {
  if (isLobby(mv)) return [];
  const u = offlineUuid(username);
  return rconAll([
    `rg addmember -w ${mv} __global__ ${u}`,
    `lp user ${u} permission set multiverse.access.${mv} true`,
  ], srv);
}

/** Revoke build access (set false, not unset, for a deterministic deny). */
export async function revokeBuild(username: string, mv: string, srv: ServerId): Promise<string[]> {
  if (isLobby(mv)) return [];
  const u = offlineUuid(username);
  const admin = !!db.query("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND is_admin = 1").get(username);
  return rconAll([
    `rg removemember -w ${mv} __global__ ${u}`,
    // Admins keep entry (view) to every world; only their build rights go.
    `lp user ${u} permission set multiverse.access.${mv} ${admin ? "true" : "false"}`,
  ], srv);
}

/** Teleport a (currently online) player to a world. `mvtp <world>` teleports to
 *  the world spawn via Multiverse's SafeTTeleporter, which ABORTS with "No safe
 *  locations found!" when the spawn is unsafe (in a block / over a drop) — the
 *  player silently never moves. Fall back to an EXACT-destination teleport
 *  (e:world:x,y,z), which bypasses the safety scan and drops them at the spawn
 *  coords regardless. Owners can then fix it permanently with /mvsetspawn. */
export async function teleportTo(username: string, mv: string, srv: ServerId): Promise<string> {
  const out = await rcon(`mvtp ${username} ${mv}`, 5000, srv);
  if (/no safe location|not safe|unsafe/i.test(stripColor(out))) {
    // Multiverse 5 takes --unsafe; 2.5 needs the exact e:world:x,y,z destination.
    if (SERVERS[srv].modern) return rcon(`mvtp ${username} ${mv} --unsafe`, 5000, srv);
    const { spawn } = await readMvWorld(mv, srv);
    if (spawn) return rcon(`mvtp ${username} e:${mv}:${spawn.x},${spawn.y},${spawn.z}`, 5000, srv);
  }
  return out;
}

/** Folder of a world on disk. 1.12: <data>/<mv>. 26.x: everything lives in the
 *  main save; extra Multiverse worlds sit under world/dimensions/minecraft/<mv>. */
export function worldDir(mv: string, srv: ServerId): string {
  if (SERVERS[srv].modern && mv !== LOBBY_MV) return `${gamedata(srv)}/world/dimensions/minecraft/${mv}`;
  return `${gamedata(srv)}/${mv}`;
}

/** Does this Multiverse world actually exist on the live server yet? (a worlds.yml
 *  entry or a saved level.dat). Used to adopt a world whose slow `mv create`
 *  finished server-side after the RCON response timed out, instead of orphaning it. */
export async function liveWorldExists(mv: string, srv: ServerId): Promise<boolean> {
  if (SERVERS[srv].modern) {
    try {
      const out = stripColor(await rcon("mv list --raw", 5000, srv));
      return new RegExp(`(^|\\s)${mv}(\\s|$)`, "m").test(out);
    } catch {
      // No disk fallback on 26: world/dimensions/minecraft/ also holds the lobby's
      // own dimension folders, so "a folder exists" can't prove a world exists.
      return false;
    }
  }
  if (readMvWorldYml(mv).difficulty !== null) return true;
  return existsSync(`${gamedata(srv)}/${mv}/level.dat`);
}

/** RCON command to create a world, in the server's dialect. seed is pre-sanitized. */
export function createWorldCommand(mv: string, seed: string, srv: ServerId): string {
  if (SERVERS[srv].modern) return seed ? `mv create ${mv} normal --seed ${seed}` : `mv create ${mv} normal`;
  return seed ? `mv create ${mv} normal -s ${seed}` : `mv create ${mv} normal`;
}

/** RCON command to set a world's persistent difficulty, in the server's dialect. */
export function difficultyCommand(mv: string, diff: string, srv: ServerId): string {
  return SERVERS[srv].modern ? `mv modify ${mv} set difficulty ${diff}` : `mvm set diff ${diff} ${mv}`;
}

/** Read a world's seed from Multiverse (used for seed-map links). null if unparseable. */
export async function fetchWorldSeed(mv: string, srv: ServerId): Promise<string | null> {
  try {
    const out = stripColor(await rcon(SERVERS[srv].modern ? `mv info ${mv} --filter seed` : `mv info ${mv}`, 5000, srv));
    const m = out.match(/Seed:\s*(-?\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Remember where to drop a player on their next join (offline hop). */
export function setPendingDestination(username: string, mv: string, srv: ServerId, ttlSec = 600): void {
  db.run(
    "INSERT OR REPLACE INTO pending_destination (username, target_world, server, created_at, expires_at) VALUES (?,?,?,?,?)",
    [username, mv, srv, now(), now() + ttlSec],
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
export interface PlayerLoc { username: string; server: ServerId; world: string; x: number; y: number; z: number; updated_at: number }
export function upsertLocation(username: string, srv: ServerId, world: string, x: number, y: number, z: number): void {
  db.run(
    `INSERT INTO player_locations (username, server, world, x, y, z, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(username, server) DO UPDATE SET world=excluded.world, x=excluded.x, y=excluded.y, z=excluded.z, updated_at=excluded.updated_at`,
    [username, srv, world, x, y, z, now()],
  );
}
/** Last-known spot of a player ON ONE server. */
export function getLocation(username: string, srv: ServerId): PlayerLoc | null {
  return db.query("SELECT * FROM player_locations WHERE username = ? COLLATE NOCASE AND server = ?").get(username, srv) as PlayerLoc | null;
}

// ── teleport history (last N the user jumped to) + saved locations ────────────
export interface TeleportEntry { id: number; world: string; x: number; y: number; z: number; label: string | null; target_user_id: string | null; created_at: number }
export interface SavedLocation { id: string; world: string; x: number; y: number; z: number; name: string; created_at: number }

export function recordTeleport(userId: string, srv: ServerId, world: string, x: number, y: number, z: number, label: string, targetUserId: string | null = null): void {
  db.run("INSERT INTO teleport_history (user_id, server, world, x, y, z, label, target_user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [userId, srv, world, x, y, z, label, targetUserId, now()]);
  // keep only the 5 most recent per user, PER WORLD (per server)
  db.run(
    `DELETE FROM teleport_history WHERE user_id = ? AND server = ? AND world = ? AND id NOT IN (
       SELECT id FROM teleport_history WHERE user_id = ? AND server = ? AND world = ? ORDER BY id DESC LIMIT 5)`,
    [userId, srv, world, userId, srv, world],
  );
}
export function recentTeleports(userId: string, srv: ServerId, world: string): TeleportEntry[] {
  return db.query("SELECT id, world, x, y, z, label, target_user_id, created_at FROM teleport_history WHERE user_id = ? AND server = ? AND world = ? ORDER BY id DESC LIMIT 5").all(userId, srv, world) as TeleportEntry[];
}
export function listSavedLocations(userId: string, srv: ServerId, world: string): SavedLocation[] {
  return db.query("SELECT id, world, x, y, z, name, created_at FROM saved_locations WHERE user_id = ? AND server = ? AND world = ? ORDER BY name COLLATE NOCASE").all(userId, srv, world) as SavedLocation[];
}
export function saveLocation(userId: string, srv: ServerId, name: string, world: string, x: number, y: number, z: number): void {
  db.run("INSERT INTO saved_locations (id, user_id, server, world, x, y, z, name, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [randomUUID(), userId, srv, world, x, y, z, name, now()]);
}
export function updateSavedLocation(userId: string, srv: ServerId, id: string, name: string, world: string, x: number, y: number, z: number): void {
  db.run("UPDATE saved_locations SET name=?, world=?, x=?, y=?, z=? WHERE id=? AND user_id=? AND server=?", [name, world, x, y, z, id, userId, srv]);
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
  await grantBuild(grantee.username, world.mv_world_name, world.server);
}

export async function unshareWorld(world: World, grantee: User): Promise<void> {
  db.run("DELETE FROM world_shares WHERE world_id = ? AND grantee_user_id = ?", [world.id, grantee.id]);
  await revokeBuild(grantee.username, world.mv_world_name, world.server);
}

/**
 * Admin: hand a world to a new owner. Updates the DB owner and re-provisions the
 * live server so the new owner gets full owner control (WorldGuard region owner,
 * Multiverse access, world-scoped op commands). The PREVIOUS owner is demoted to
 * a shared build member (kept, not abruptly cut off — an admin can revoke after);
 * their owner region grant + op command nodes are stripped. Notes, shares and
 * saved locations are keyed by world_id and carry over untouched. Throws on the
 * UNIQUE(owner_user_id, name) constraint if the new owner already has a world by
 * the same display name (caller surfaces it).
 */
export async function reassignWorldOwner(world: World, newOwner: User, adminUserId: string): Promise<void> {
  const oldOwner = db.query("SELECT * FROM users WHERE id = ?").get(world.owner_user_id) as User | null;
  if (oldOwner && oldOwner.id === newOwner.id) return; // already the owner
  // Flip ownership first (may throw on UNIQUE(owner_user_id, name) — that's caught upstream).
  db.run("UPDATE worlds SET owner_user_id = ? WHERE id = ?", [newOwner.id, world.id]);
  // New owner: full owner provisioning; and they shouldn't linger as a 'shared' row.
  await provisionWorld(world.mv_world_name, newOwner.username, world.server);
  db.run("DELETE FROM world_shares WHERE world_id = ? AND grantee_user_id = ?", [world.id, newOwner.id]);
  // Old owner: drop owner region + op nodes, keep as a shared build member.
  if (oldOwner) {
    const oldUuid = offlineUuid(oldOwner.username);
    await rconAll([`rg removeowner -w ${world.mv_world_name} __global__ ${oldUuid}`], world.server).catch(() => {});
    await revokeOwnerCommands(world.mv_world_name, oldOwner.username, world.server).catch(() => {});
    db.run(
      "INSERT OR IGNORE INTO world_shares (id, world_id, grantee_user_id, granted_by, created_at) VALUES (?,?,?,?,?)",
      [randomUUID(), world.id, oldOwner.id, adminUserId, now()],
    );
    await grantBuild(oldOwner.username, world.mv_world_name, world.server).catch(() => {});
  }
}

/**
 * Move all in-game access from an old username to a new one after a rename. The
 * offline UUID derives from the username, so every WorldGuard/LuckPerms grant
 * keyed on the OLD uuid must be revoked and re-pushed under the NEW uuid. Worlds
 * + shares themselves are keyed by user_id and don't change; only these
 * UUID-derived grants do. Builds (world blocks) are untouched and persist.
 * Best-effort per command (mirrors reconcile()); a kick forces a clean reconnect.
 */
export async function transferInGameIdentity(userId: string, oldUsername: string, newUsername: string): Promise<{ moved: number }> {
  const oldUuid = offlineUuid(oldUsername);
  // 1. Kick the old name FIRST so a connected player disconnects (which flushes
  //    their live character data to the OLD uuid .dat) and will reconnect cleanly
  //    under the new identity. Harmless no-op if they're offline.
  for (const srv of enabledServers()) {
    await rcon(`kick ${oldUsername} Your username changed — reconnect to continue`, 5000, srv).catch(() => {});
  }
  // 2. Let the disconnect-save settle before we move files off the old uuid.
  await new Promise((r) => setTimeout(r, 1500));
  // 3. Carry inventory/enderchest/position/XP/stats/advancements old uuid -> new,
  //    on every server (each keeps its own character data).
  let movedTotal = 0;
  for (const srv of enabledServers()) movedTotal += transferPlayerData(oldUsername, newUsername, srv).moved;
  // 4. Owned worlds: strip the old identity as owner/member/access, then
  //    re-provision the new one (provisionWorld re-adds owner + access).
  for (const w of listWorldsOwnedBy(userId)) {
    await rconAll([
      `rg removeowner -w ${w.mv_world_name} __global__ ${oldUuid}`,
      `rg removemember -w ${w.mv_world_name} __global__ ${oldUuid}`,
      `lp user ${oldUuid} permission set multiverse.access.${w.mv_world_name} false`,
    ], w.server).catch(() => {});
    await revokeOwnerCommands(w.mv_world_name, oldUsername, w.server).catch(() => {}); // strip old uuid's op nodes
    await provisionWorld(w.mv_world_name, newUsername, w.server).catch(() => {});      // re-grants under new uuid
  }
  // 4b. Admin entry: strip it from the old uuid, grant it to the new one.
  const isAdm = !!db.query("SELECT 1 FROM users WHERE id = ? AND is_admin = 1").get(userId);
  if (isAdm) {
    await revokeAdminEntry(oldUsername, userId).catch(() => {});
    await grantAdminEntry(newUsername).catch(() => {});
  }
  // 5. Shared-with worlds: revoke the old uuid's build grant, grant the new uuid's.
  for (const w of listWorldsSharedWith(userId)) {
    await revokeBuild(oldUsername, w.mv_world_name, w.server).catch(() => {});
    await grantBuild(newUsername, w.mv_world_name, w.server).catch(() => {});
  }
  return { moved: movedTotal };
}

// Worlds that must never be deleted: Bukkit's defaults (the shared lobby is
// "world") and the seeded bootstrap world (which would just be re-created on the
// next boot, causing drift).
const PROTECTED_WORLDS = new Set(["world", "world_nether", "world_the_end", "cliffbuild", "overworld", "the_nether", "the_end"]);
export function isProtectedWorld(mv: string): boolean { return PROTECTED_WORLDS.has(mv); }

/**
 * Admin: permanently delete a world — the live Multiverse world + its files, all
 * LuckPerms/WorldGuard grants, and every DB row tied to it. Removes it from the
 * SERVER first; only on success does it touch the DB, so a failed server-side
 * delete never leaves the panel claiming success or drifting. The caller must
 * evacuate any players first and enforce who-may-delete.
 */
export async function deleteWorld(world: World): Promise<{ ok: boolean; error?: string }> {
  const mv = world.mv_world_name;
  const srv = world.server;
  if (isProtectedWorld(mv) || !/^[a-z0-9_-]{1,32}$/.test(mv)) {
    return { ok: false, error: "That world is protected or has an invalid name." };
  }
  // 1. Remove the live world. Multiverse's delete needs a confirm from the SAME
  //    console sender, which RCON is — run both back to back.
  try {
    const out = stripColor(await rcon(`mv delete ${mv}`, 5000, srv));
    // Multiverse 5 demands the one-time number it prints ("Run /mv confirm 428").
    const otp = out.match(/confirm\s+(\d+)/i);
    await rcon(otp ? `mv confirm ${otp[1]}` : `mv confirm`, 15000, srv);
  } catch (e: any) {
    return { ok: false, error: "Couldn't remove the world from the server (RCON): " + (e?.message || e) };
  }
  // 2. Strip LuckPerms grants so nothing lingers (the WorldGuard region dies with
  //    the world). Owner: command nodes + access; every shared member: build.
  const owner = db.query("SELECT username FROM users WHERE id = ?").get(world.owner_user_id) as { username: string } | null;
  if (owner) {
    await revokeOwnerCommands(mv, owner.username, srv).catch(() => {});
    await rconAll([`lp user ${offlineUuid(owner.username)} permission unset multiverse.access.${mv}`], srv).catch(() => {});
  }
  // Admin entry grants (see provisionWorld) — don't let them outlive the world.
  await rconAll(adminUsernames().map((a) => `lp user ${offlineUuid(a)} permission unset multiverse.access.${mv}`), srv).catch(() => {});
  for (const s of sharesForWorld(world.id)) await revokeBuild(s.username, mv, srv).catch(() => {});
  // 3. Force-remove any leftover world directory (Bun's $ escapes the interpolation;
  //    mv is charset-validated above so this can't traverse).
  await $`rm -rf ${worldDir(mv, srv)}`.quiet().nothrow();
  // 4. Delete every DB row for the world in one transaction.
  db.transaction(() => {
    db.run("DELETE FROM world_shares WHERE world_id = ?", [world.id]);
    db.run("DELETE FROM world_notes WHERE world_id = ?", [world.id]);
    db.run("DELETE FROM saved_locations WHERE world = ? AND server = ?", [mv, srv]);
    db.run("DELETE FROM teleport_history WHERE world = ? AND server = ?", [mv, srv]);
    db.run("DELETE FROM worlds WHERE id = ?", [world.id]);
  })();
  return { ok: true };
}

/** Seed the existing cliff build as a world owned by the server owner (once). */
export function bootstrapWorlds(): void {
  const ownerEmail = (process.env.ADMIN_EMAILS || "").split(",")[0].trim().toLowerCase();
  if (!ownerEmail) return;
  const owner = db.query("SELECT * FROM users WHERE email = ?").get(ownerEmail) as User | null;
  if (!owner) return; // owner hasn't logged in yet; seed on a later boot
  if (!getWorldByMv("cliffbuild", "18")) {
    insertWorld({ id: randomUUID(), name: "Cliff Build", mv_world_name: "cliffbuild", owner_user_id: owner.id, world_type: "normal", seed: null, source: "import", status: "active", server: "18" });
    console.log(`seeded world: cliffbuild (owner ${owner.username})`);
  }
  // Register each server's shared lobby (display-only; see LOBBY_MV — never provisioned).
  for (const srv of enabledServers()) {
    if (!getWorldByMv(LOBBY_MV, srv)) {
      insertWorld({ id: randomUUID(), name: srv === "18" ? "Lobby" : "Lobby (26)", mv_world_name: LOBBY_MV, owner_user_id: owner.id, world_type: "normal", seed: null, source: "import", status: "active", server: srv });
      console.log(`seeded world: ${LOBBY_MV} on ${SERVERS[srv].label} (lobby, open to all)`);
    }
  }
}

/** Reconciler: re-push every active share's grant so the live server self-heals. */
export async function reconcile(): Promise<{ worlds: number; grants: number }> {
  const on = new Set(enabledServers());
  const worlds = listAllWorlds().filter((w) => w.status === "active" && on.has(w.server));
  let grants = 0;
  for (const w of worlds) {
    const owner = db.query("SELECT username FROM users WHERE id = ?").get(w.owner_user_id) as { username: string } | null;
    if (owner) await provisionWorld(w.mv_world_name, owner.username, w.server).catch(() => {});
    for (const s of sharesForWorld(w.id)) {
      await grantBuild(s.username, w.mv_world_name, w.server).catch(() => {});
      grants++;
    }
    // Backfill the seed once (for seed-map links); self-heals existing worlds.
    if (!w.seed) {
      const seed = await fetchWorldSeed(w.mv_world_name, w.server);
      if (seed) db.run("UPDATE worlds SET seed = ? WHERE id = ?", [seed, w.id]);
    }
  }
  return { worlds: worlds.length, grants };
}
