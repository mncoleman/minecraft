// The Map tab: every world drawn the way an in-game map draws it, with a
// features layer Claude keeps current over MCP, and drill-down floor plans with
// live redstone for areas like the fortress.
//
//   terrain   auth/map/tiles.py renders region files (read-only, off the game
//             thread) into 512px tiles + a zoom pyramid under MAP_DIR. Every 10
//             minutes, and on demand; only regions whose file changed re-render.
//   areas     auth/map/slice.py cuts floor plans at each floor level of an area
//             and lists every redstone part's position. The plugin (/states) then
//             reads those positions live; /lever flips a lever with real physics.
//   features  SQLite (map_features), written by the MCP `map` tool, logged to
//             map_updates for the "Recent map updates" feed.
//
// Secret passages (secret=1) are visible only to the world's owner and admins:
// hidden from the features list and the feed, painted over as wall in the floor
// plans served to everyone else (slice.py writes a _pub copy), and their
// components are left out of the redstone layer.
import type { Hono, Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { db, type User } from "./db.ts";
import { config } from "./config.ts";
import { currentSession, rateLimited } from "./session.ts";
import { SERVERS, isEnabled, parseServer, serverLabel, type ServerId } from "./servers.ts";
import { getWorldByMv, listAllWorlds, isLobby, listSavedLocations, worldDir, type World } from "./worlds.ts";
import { shell, esc, pageHead, edBadge } from "./layout.ts";
import { plugin } from "./buildapi.ts";
import { rcon } from "./rcon.ts";

const now = () => Math.floor(Date.now() / 1000);
const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();
const MAP_DIR = (process.env.MAP_DIR || join(dirname(config.dbPath), "map")).replace(/\/+$/, "");
const PY_DIR = new URL("../map/", import.meta.url).pathname;
const RENDER_EVERY_MS = 10 * 60 * 1000;

// ── schema ───────────────────────────────────────────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS map_features (
  id          TEXT PRIMARY KEY,
  server      TEXT NOT NULL,
  world       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  x INTEGER, y INTEGER, z INTEGER,
  points      TEXT,
  box         TEXT,
  floors      TEXT,
  labels      TEXT,
  secret      INTEGER NOT NULL DEFAULT 0,
  underground INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(server, world, slug)
)`);
db.run(`CREATE TABLE IF NOT EXISTS map_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server     TEXT NOT NULL,
  world      TEXT NOT NULL,
  feature_id TEXT,
  slug       TEXT,
  action     TEXT NOT NULL,
  title      TEXT NOT NULL,
  what       TEXT NOT NULL DEFAULT '',
  actor      TEXT,
  secret     INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_map_updates_world ON map_updates(server, world, at)");
db.run(`CREATE TABLE IF NOT EXISTS map_worlds (
  server       TEXT NOT NULL,
  world        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'new',
  summary      TEXT,
  requested_at INTEGER,
  rendered_at  INTEGER,
  PRIMARY KEY (server, world)
)`);
// Homeland on 26 is the first mapped world.
db.run("INSERT OR IGNORE INTO map_worlds (server, world, enabled, status) VALUES ('26', 'homeland', 1, 'new')");

// ── features ─────────────────────────────────────────────────────────────────
export const KINDS: Record<string, { label: string; layer: string }> = {
  wall: { label: "Wall", layer: "walls" },
  tower: { label: "Tower", layer: "walls" },
  gate: { label: "Gate", layer: "walls" },
  building: { label: "Building", layer: "buildings" },
  area: { label: "Area", layer: "buildings" },
  passage: { label: "Passage", layer: "underground" },
  rail: { label: "Rail line", layer: "underground" },
  place: { label: "Place", layer: "places" },
  planned: { label: "Planned", layer: "planned" },
  keepclear: { label: "Keep clear", layer: "keepclear" },
  control: { label: "Control", layer: "controls" },
};
/** How a lever, button or sensor is used: shown in the Controls card. */
export interface ControlInfo { group?: string; type?: string; reach?: string; on?: string; off?: string; drives?: string; verified?: boolean }

type V3 = [number, number, number];
export interface Floor { y: number; name: string }
export interface Feature {
  id: string; server: ServerId; world: string; slug: string; kind: string; name: string; detail: string; status: string;
  x: number | null; y: number | null; z: number | null;
  points: number[][] | null; box: { from: V3; to: V3 } | null; floors: Floor[] | "auto" | null;
  labels: { rooms?: Array<{ name: string; x: number; z: number; y?: number }>; levers?: Record<string, string>; control?: ControlInfo } | null;
  secret: boolean; underground: boolean; created_by: string | null; created_at: number; updated_at: number;
}
function parseJ<T>(s: unknown): T | null { if (typeof s !== "string" || !s) return null; try { return JSON.parse(s) as T; } catch { return null; } }
function rowToFeature(r: any): Feature {
  return {
    id: r.id, server: r.server, world: r.world, slug: r.slug, kind: r.kind, name: r.name, detail: r.detail, status: r.status,
    x: r.x, y: r.y, z: r.z, points: parseJ(r.points), box: parseJ(r.box), floors: r.floors === "auto" ? "auto" : parseJ(r.floors),
    labels: parseJ(r.labels), secret: !!r.secret, underground: !!r.underground, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}
export function listFeatures(srv: ServerId, mv: string, withSecret: boolean): Feature[] {
  return (db.query("SELECT * FROM map_features WHERE server = ? AND world = ? ORDER BY kind, name COLLATE NOCASE").all(srv, mv) as any[])
    .map(rowToFeature).filter((f) => withSecret || !f.secret);
}
export function getFeature(srv: ServerId, mv: string, idOrSlug: string): Feature | null {
  const r = db.query("SELECT * FROM map_features WHERE server = ? AND world = ? AND (id = ? OR slug = ? COLLATE NOCASE)").get(srv, mv, idOrSlug, idOrSlug);
  return r ? rowToFeature(r) : null;
}
export function recentUpdates(srv: ServerId, mv: string, withSecret: boolean, limit = 12) {
  return (db.query(`SELECT id, feature_id, slug, action, title, what, actor, at FROM map_updates WHERE server = ? AND world = ? ${withSecret ? "" : "AND secret = 0"} ORDER BY at DESC, id DESC LIMIT ?`).all(srv, mv, limit) as any[]);
}
// BlueMap (bluemap.ts) listens for feature changes to re-push markers and, for
// secrets, re-cut its render mask. A callback, not an import, so the two modules
// don't import each other.
type FeatureListener = (srv: ServerId, mv: string, secretChanged: boolean) => void;
let featureListener: FeatureListener | null = null;
export function setFeatureListener(fn: FeatureListener): void { featureListener = fn; }
let blueMapProbe: (() => Promise<string[]>) | null = null;
export function setBlueMapProbe(fn: () => Promise<string[]>): void { blueMapProbe = fn; }
function logUpdate(f: { id: string; slug: string; server: string; world: string; secret: boolean }, action: string, title: string, what: string, actor: string | null) {
  try { featureListener?.(f.server as ServerId, f.world, f.secret); } catch { /* best effort */ }
  db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [f.server, f.world, f.id, f.slug, action, title.slice(0, 120), what.slice(0, 400), actor, f.secret ? 1 : 0, now()]);
}

// Validation shared by the MCP tool and the seed. Every coordinate is an integer
// in world bounds; text is trimmed and capped; JSON blobs stay small.
const int = (v: unknown, what: string, min = -29_999_000, max = 29_999_000): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be an integer${min > -1e6 ? ` between ${min} and ${max}` : ""}.`);
  return n;
};
const yv = (v: unknown, what: string) => int(v, what, -64, 320);
function vec3(v: unknown, what: string): V3 {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what} must be [x, y, z].`);
  return [int(v[0], what + " x"), yv(v[1], what + " y"), int(v[2], what + " z")];
}
export function truthy(v: unknown): boolean { return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true"; }
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "feature";
}
export interface FeatureInput {
  slug?: string; kind?: string; name?: string; detail?: string; status?: string; pos?: unknown; points?: unknown; box?: unknown;
  floors?: unknown; rooms?: unknown; levers?: unknown; secret?: unknown; underground?: unknown; control?: unknown;
}
function cleanFields(a: FeatureInput, partial: boolean): Record<string, any> {
  const o: Record<string, any> = {};
  if (a.kind !== undefined || !partial) {
    const k = String(a.kind ?? "").toLowerCase().trim();
    if (!KINDS[k]) throw new Error(`kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
    o.kind = k;
  }
  if (a.name !== undefined || !partial) {
    const n = String(a.name ?? "").trim().slice(0, 80);
    if (!n) throw new Error("name is required.");
    o.name = n;
  }
  if (a.detail !== undefined) o.detail = String(a.detail ?? "").trim().slice(0, 1200);
  if (a.status !== undefined) o.status = String(a.status ?? "").trim().slice(0, 40);
  if (a.pos !== undefined) {
    if (a.pos === null) { o.x = o.y = o.z = null; }
    else { const p = vec3(a.pos, "pos"); o.x = p[0]; o.y = p[1]; o.z = p[2]; }
  }
  if (a.points !== undefined) {
    if (a.points === null) o.points = null;
    else {
      if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 400) throw new Error("points must be 2-400 entries of [x, z] or [x, y, z].");
      o.points = JSON.stringify(a.points.map((p: any, i: number) => {
        if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw new Error(`points[${i}] must be [x, z] or [x, y, z].`);
        return p.length === 2 ? [int(p[0], "x"), int(p[1], "z")] : [int(p[0], "x"), yv(p[1], "y"), int(p[2], "z")];
      }));
    }
  }
  if (a.box !== undefined) {
    if (a.box === null) o.box = null;
    else {
      const b = a.box as any;
      const f = vec3(b?.from, "box.from"), t = vec3(b?.to, "box.to");
      const from: V3 = [Math.min(f[0], t[0]), Math.min(f[1], t[1]), Math.min(f[2], t[2])];
      const to: V3 = [Math.max(f[0], t[0]), Math.max(f[1], t[1]), Math.max(f[2], t[2])];
      if (to[0] - from[0] > 600 || to[2] - from[2] > 600) throw new Error("box can be at most 600 x 600 blocks.");
      o.box = JSON.stringify({ from, to });
    }
  }
  if (a.floors !== undefined) {
    if (a.floors === null) o.floors = null;
    else if (a.floors === "auto") o.floors = "auto";
    else {
      if (!Array.isArray(a.floors) || a.floors.length > 12) throw new Error("floors must be 'auto' or up to 12 entries of {y, name} (or plain y numbers).");
      o.floors = JSON.stringify(a.floors.map((f: any) => typeof f === "number"
        ? { y: yv(f, "floor y"), name: `Level ${f}` }
        : { y: yv(f?.y, "floor y"), name: String(f?.name ?? `Level ${f?.y}`).trim().slice(0, 40) }).sort((p: Floor, q: Floor) => p.y - q.y));
    }
  }
  if (a.rooms !== undefined || a.levers !== undefined || a.control !== undefined) {
    o.__labels = {} as any;
    if (a.control !== undefined) {
      const c: any = a.control;
      if (c !== null && (typeof c !== "object" || Array.isArray(c))) throw new Error("control must be an object {group, type, reach, on, off, drives, verified}.");
      const t = (k: string, n = 600) => (c?.[k] === undefined || c?.[k] === null ? undefined : String(c[k]).trim().slice(0, n));
      o.__labels.control = c === null ? undefined : {
        group: t("group", 60), type: t("type", 20), reach: t("reach"), on: t("on"), off: t("off"), drives: t("drives"),
        verified: c?.verified === undefined ? undefined : truthy(c.verified),
      };
    }
    if (a.rooms !== undefined) {
      if (a.rooms !== null && (!Array.isArray(a.rooms) || a.rooms.length > 80)) throw new Error("rooms must be up to 80 entries of {name, x, z, y?}.");
      o.__labels.rooms = a.rooms === null ? undefined : (a.rooms as any[]).map((r) => ({ name: String(r?.name ?? "").trim().slice(0, 40), x: int(r?.x, "room x"), z: int(r?.z, "room z"), ...(r?.y !== undefined && r?.y !== null ? { y: yv(r.y, "room y") } : {}) }));
    }
    if (a.levers !== undefined) {
      const lv: Record<string, string> = {};
      const src: any = a.levers;
      if (src !== null) {
        const list: Array<[unknown, unknown]> = Array.isArray(src) ? src.map((e: any) => [e?.pos, e?.name]) : Object.entries(src).map(([k, v]) => [k.split(/[ ,]+/).map(Number), v]);
        if (list.length > 200) throw new Error("levers: up to 200 names.");
        for (const [p, n] of list) { const q = vec3(p, "lever pos"); lv[q.join(",")] = String(n ?? "").trim().slice(0, 60); }
      }
      o.__labels.levers = src === null ? undefined : lv;
    }
  }
  if (a.secret !== undefined) o.secret = truthy(a.secret) ? 1 : 0;
  if (a.underground !== undefined) o.underground = a.underground ? 1 : 0;
  return o;
}
/** A box with floors gets sliced: keep it to something the renderer handles fast. */
function checkArea(box: { from: V3; to: V3 } | null, floors: unknown, srv: ServerId, mv: string, selfId?: string): void {
  if (!box || !floors) return;
  const dx = box.to[0] - box.from[0] + 1, dy = box.to[1] - box.from[1] + 1, dz = box.to[2] - box.from[2] + 1;
  if (dx > 256 || dz > 256) throw new Error("An area with floor plans can be at most 256 x 256 blocks. Split it into parts.");
  if (dx * dy * dz > 3_000_000) throw new Error(`An area with floor plans can hold at most 3 million blocks (this one is ${dx} x ${dy} x ${dz}). Trim its height or split it.`);
  const n = listFeatures(srv, mv, true).filter((f) => f.box && f.floors && f.id !== selfId).length;
  if (n >= 40) throw new Error("This world already has 40 areas with floor plans.");
}
function anchorFrom(o: Record<string, any>, cur?: Feature | null): void {
  // A feature always gets an anchor (where its marker sits): pos, else the box
  // centre at floor level, else the first point.
  const hasPos = (o.x ?? cur?.x) !== null && (o.x ?? cur?.x) !== undefined;
  if (hasPos) return;
  const box = o.box !== undefined ? parseJ<{ from: V3; to: V3 }>(o.box) : cur?.box;
  if (box) { o.x = Math.round((box.from[0] + box.to[0]) / 2); o.z = Math.round((box.from[2] + box.to[2]) / 2); o.y = o.y ?? null; return; }
  const pts = o.points !== undefined ? parseJ<number[][]>(o.points) : cur?.points;
  if (pts && pts.length) { const p = pts[0]; o.x = p[0]; o.z = p[p.length - 1]; o.y = p.length === 3 ? p[1] : null; }
}
export function addFeature(srv: ServerId, mv: string, a: FeatureInput, actor: string | null, note?: string): Feature {
  const o = cleanFields(a, false);
  checkArea(o.box ? JSON.parse(o.box) : null, o.floors, srv, mv);
  anchorFrom(o);
  if (o.x === undefined || o.x === null) throw new Error("Give the feature a position: pos [x,y,z], a box, or points.");
  const base = slugify(String(a.slug ?? o.name));
  let slug = base;
  if (getFeature(srv, mv, slug)) {
    if (a.slug) throw new Error(`A feature with id '${slug}' already exists in ${mv}. Use action 'update'.`);
    let i = 2;
    while (getFeature(srv, mv, `${base}-${i}`)) if (++i > 500) throw new Error("Too many features with that name.");
    slug = `${base}-${i}`;
  }
  const labels = o.__labels ? JSON.stringify(o.__labels) : null;
  const id = randomUUID(), t = now();
  if (listFeatures(srv, mv, true).length >= 2000) throw new Error("This world already has 2000 map features.");
  db.run(`INSERT INTO map_features (id, server, world, slug, kind, name, detail, status, x, y, z, points, box, floors, labels, secret, underground, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, srv, mv, slug, o.kind, o.name, o.detail ?? "", o.status ?? "", o.x ?? null, o.y ?? null, o.z ?? null, o.points ?? null, o.box ?? null, o.floors ?? null, labels, o.secret ?? 0, o.underground ?? 0, actor, t, t]);
  const f = getFeature(srv, mv, id)!;
  logUpdate(f, "add", f.name, note || `Added ${KINDS[f.kind].label.toLowerCase()}${f.detail ? ": " + f.detail : "."}`, actor);
  if ((f.box && f.floors) || f.secret) touchArea(srv, mv, f.secret);
  return f;
}
export function updateFeature(srv: ServerId, mv: string, idOrSlug: string, a: FeatureInput, actor: string | null, note?: string): Feature {
  const cur = getFeature(srv, mv, idOrSlug);
  if (!cur) throw new Error(`No feature '${idOrSlug}' in ${mv}.`);
  const o = cleanFields(a, true);
  checkArea(o.box !== undefined ? (o.box ? JSON.parse(o.box) : null) : cur.box, o.floors !== undefined ? o.floors : cur.floors, srv, mv, cur.id);
  if (o.__labels) {
    const merged = { ...(cur.labels || {}) } as any;
    for (const k of Object.keys(o.__labels)) { if (o.__labels[k] === undefined) delete merged[k]; else merged[k] = o.__labels[k]; }
    o.labels = JSON.stringify(merged);
    delete o.__labels;
  }
  if (a.slug !== undefined && slugify(String(a.slug)) !== cur.slug) {
    const s = slugify(String(a.slug));
    if (getFeature(srv, mv, s)) throw new Error(`id '${s}' is taken.`);
    o.slug = s;
  }
  const cols = Object.keys(o);
  if (!cols.length) return cur;
  db.run(`UPDATE map_features SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...cols.map((k) => o[k]), now(), cur.id]);
  const f = getFeature(srv, mv, cur.id)!;
  if (f.secret !== cur.secret) db.run("UPDATE map_updates SET secret = ? WHERE feature_id = ?", [f.secret ? 1 : 0, f.id]); // its history follows it
  const changed = cols.filter((k) => k !== "labels").map((k) => (k === "x" || k === "z" ? "position" : k === "y" ? "" : k)).filter(Boolean);
  if (o.labels) changed.push("labels");
  logUpdate(f, "update", f.name, note || `Updated ${[...new Set(changed)].join(", ")}.`, actor);
  if ((f.box && f.floors) || (cur.box && cur.floors) || f.secret || cur.secret) touchArea(srv, mv, f.secret || cur.secret);
  return f;
}
export function removeFeature(srv: ServerId, mv: string, idOrSlug: string, actor: string | null, note?: string): Feature {
  const cur = getFeature(srv, mv, idOrSlug);
  if (!cur) throw new Error(`No feature '${idOrSlug}' in ${mv}.`);
  db.run("DELETE FROM map_features WHERE id = ?", [cur.id]);
  logUpdate(cur, "remove", cur.name, note || "Removed from the map.", actor);
  if (cur.secret || (cur.box && cur.floors)) touchArea(srv, mv, cur.secret);
  return cur;
}
/** Something that shapes an area's slice changed: re-slice soon. When a secret
 *  changed, drop every public floor plan of the world right now, so no plan cut
 *  before the secret existed is served until the re-slice paints it over. */
function touchArea(srv: ServerId, mv: string, secretChanged = false): void {
  if (secretChanged) {
    try { featureListener?.(srv, mv, true); } catch { /* best effort */ }
    for (const f of areaFeatures(srv, mv)) {
      const dir = `${outDir(srv, mv)}/areas/${f.id}`;
      try { for (const n of readdirSync(dir)) if (/_pub\.png$/.test(n)) unlinkSync(`${dir}/${n}`); writeFileSync(`${dir}/spec.json`, ""); } catch { /* not sliced yet */ }
    }
  }
  setTimeout(() => enqueue(srv, mv, "feature change"), 1500);
}

// ── who may see / do what ────────────────────────────────────────────────────
// Secret passages are shown to everyone signed in (owner, 2026-11-17: "allow all
// areas... there is nothing to hide"). Flip this to true to hide them again from
// everyone but the world's owner and admins (features, feed, plans, components,
// MCP list); the masking code paths below all key off it.
export const SECRETS_PRIVATE = false;
const seesSecrets = (priv: boolean) => priv || !SECRETS_PRIVATE;
interface Viewer { sub: string; username: string; admin: boolean; siteOwner: boolean }
async function viewer(c: Context): Promise<Viewer | null> {
  const s = await currentSession(c);
  if (!s) return null;
  const u = db.query("SELECT email FROM users WHERE id = ?").get(s.sub) as { email: string | null } | null;
  return { sub: s.sub, username: s.username, admin: !!s.admin, siteOwner: !!u?.email && u.email.toLowerCase() === OWNER_EMAIL };
}
/** World owner or admin: sees secret passages, may flip levers, may force a render. */
export function privileged(v: { sub: string; admin: boolean; siteOwner?: boolean }, w: World | null): boolean {
  return v.admin || !!v.siteOwner || (!!w && w.owner_user_id === v.sub);
}
function userPrivileged(u: User, w: World | null): boolean {
  return privileged({ sub: u.id, admin: !!u.is_admin, siteOwner: !!u.email && u.email.toLowerCase() === OWNER_EMAIL }, w);
}

// ── files ────────────────────────────────────────────────────────────────────
const MV_RE = /^[A-Za-z0-9_-]{1,32}$/;
function outDir(srv: ServerId, mv: string): string { return `${MAP_DIR}/${srv}/${mv}`; }
function regionDir(srv: ServerId, mv: string): string {
  if (SERVERS[srv].modern && isLobby(mv)) {
    const d = `${SERVERS[srv].gamedataDir}/world/dimensions/minecraft/overworld/region`;
    if (existsSync(d)) return d;
    return `${SERVERS[srv].gamedataDir}/world/region`;
  }
  return `${worldDir(mv, srv)}/region`;
}
function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } }
interface Manifest { regions: Record<string, { mtime: number }>; tiles: Record<string, number>; bounds: { x0: number; z0: number; x1: number; z1: number } | null; min_zoom: number; pending: number; rendered_at: number }
function manifest(srv: ServerId, mv: string): Manifest | null { return readJson<Manifest>(`${outDir(srv, mv)}/manifest.json`); }

// ── render queue (one job at a time, niced, never on the game thread) ────────
interface MapWorldRow { server: ServerId; world: string; enabled: number; status: string; summary: string | null; requested_at: number | null; rendered_at: number | null }
function mapWorld(srv: ServerId, mv: string): MapWorldRow | null {
  return db.query("SELECT * FROM map_worlds WHERE server = ? AND world = ?").get(srv, mv) as MapWorldRow | null;
}
const queue: Array<{ srv: ServerId; mv: string; force: boolean; why: string }> = [];
let running: string | null = null;
export function enqueue(srv: ServerId, mv: string, why: string, force = false): void {
  if (!MV_RE.test(mv) || !isEnabled(srv)) return;
  const key = `${srv}/${mv}`;
  const q = queue.find((j) => `${j.srv}/${j.mv}` === key);
  if (q) { q.force ||= force; return; }
  queue.push({ srv, mv, force, why });
  db.run("INSERT INTO map_worlds (server, world, enabled, status, requested_at) VALUES (?,?,1,'queued',?) ON CONFLICT(server, world) DO UPDATE SET enabled = 1, requested_at = excluded.requested_at, status = CASE WHEN status = 'rendering' THEN status ELSE 'queued' END",
    [srv, mv, now()]);
  void pump();
}
async function runPy(args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["nice", "-n", "15", "python3", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}
async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = `${job.srv}/${job.mv}`;
  db.run("UPDATE map_worlds SET status = 'rendering' WHERE server = ? AND world = ?", [job.srv, job.mv]);
  try {
    const summary = await renderWorld(job.srv, job.mv, job.force);
    db.run("UPDATE map_worlds SET status = ?, summary = ?, rendered_at = ? WHERE server = ? AND world = ?",
      [summary.pending > 0 ? "partial" : "ok", JSON.stringify(summary), now(), job.srv, job.mv]);
    if (summary.pending > 0) setTimeout(() => enqueue(job.srv, job.mv, "continue"), 2000);
  } catch (e: any) {
    console.error(`map render ${running} failed:`, e?.message || e);
    db.run("UPDATE map_worlds SET status = ?, rendered_at = ? WHERE server = ? AND world = ?", ["error: " + String(e?.message || e).slice(0, 200), now(), job.srv, job.mv]);
  } finally {
    running = null;
    setTimeout(() => void pump(), 250);
  }
}
async function renderWorld(srv: ServerId, mv: string, force: boolean): Promise<any> {
  const rd = regionDir(srv, mv);
  if (!existsSync(rd)) throw new Error(`no region files for ${mv} (${rd})`);
  const out = outDir(srv, mv);
  mkdirSync(out, { recursive: true });
  const t = await runPy([PY_DIR + "tiles.py", rd, out, "--budget", "300", ...(force ? ["--force"] : [])], 15 * 60 * 1000);
  if (t.code !== 0) throw new Error("tiles.py: " + (t.err.trim().split("\n").pop() || `exit ${t.code}`));
  const sum: any = JSON.parse(t.out.trim().split("\n").pop() || "{}");
  sum.areas = await sliceAreas(srv, mv, rd, force);
  sum.controls = await sliceControls(srv, mv, rd, force);
  console.log(`map render ${srv}/${mv}:`, JSON.stringify(sum));
  return sum;
}
/** Secret boxes (3D) in a world: what the public floor plans paint over. */
export function secretMasks(srv: ServerId, mv: string): Array<{ from: V3; to: V3 }> {
  const out: Array<{ from: V3; to: V3 }> = [];
  for (const f of listFeatures(srv, mv, true)) {
    if (!f.secret) continue;
    if (f.box) out.push(f.box);
    if (f.points && f.points.length >= 2) {
      for (let i = 1; i < f.points.length; i++) {
        const a = f.points[i - 1], b = f.points[i];
        const ay = a.length === 3 ? a[1] : f.y, by = b.length === 3 ? b[1] : f.y;
        const ax = a[0], az = a[a.length - 1], bx = b[0], bz = b[b.length - 1];
        const y0 = ay === null || by === null ? -64 : Math.min(ay!, by!) - 1, y1 = ay === null || by === null ? 320 : Math.max(ay!, by!) + 3;
        out.push({ from: [Math.min(ax, bx) - 1, y0, Math.min(az, bz) - 1], to: [Math.max(ax, bx) + 1, y1, Math.max(az, bz) + 1] });
      }
    } else if (!f.box && f.x !== null && f.z !== null) {
      out.push({ from: [f.x - 1, (f.y ?? 0) - 1, f.z - 1], to: [f.x + 1, (f.y ?? 0) + 3, f.z + 1] });
    }
  }
  return out;
}
function boxesTouch(a: { from: V3; to: V3 }, b: { from: V3; to: V3 }): boolean {
  return a.from[0] <= b.to[0] && b.from[0] <= a.to[0] && a.from[1] <= b.to[1] && b.from[1] <= a.to[1] && a.from[2] <= b.to[2] && b.from[2] <= a.to[2];
}
function areaFeatures(srv: ServerId, mv: string): Feature[] { return listFeatures(srv, mv, true).filter((f) => f.box && f.floors); }
async function sliceAreas(srv: ServerId, mv: string, rd: string, force: boolean): Promise<number> {
  const man = manifest(srv, mv);
  const masks = secretMasks(srv, mv);
  let n = 0;
  for (const f of areaFeatures(srv, mv)) {
    const dir = `${outDir(srv, mv)}/areas/${f.id}`;
    mkdirSync(dir, { recursive: true });
    const spec = { box: f.box, floors: f.floors === "auto" ? "auto" : (f.floors as Floor[]).map((x) => x.y), masks: masks.filter((m) => boxesTouch(m, f.box!)) };
    const specStr = JSON.stringify(spec);
    const prevSpec = existsSync(`${dir}/spec.json`) ? readFileSync(`${dir}/spec.json`, "utf8") : "";
    const meta = readJson<{ generated_at: number }>(`${dir}/floors.json`);
    let stale = force || !meta || prevSpec !== specStr;
    if (!stale && man) {
      const b = f.box!;
      for (let rx = b.from[0] >> 9; rx <= b.to[0] >> 9 && !stale; rx++)
        for (let rz = b.from[2] >> 9; rz <= b.to[2] >> 9 && !stale; rz++) {
          const r = man.regions[`${rx},${rz}`];
          if (r && r.mtime > meta!.generated_at) stale = true;
        }
    }
    if (!stale) continue;
    writeFileSync(`${dir}/spec.json`, specStr);
    const r = await runPy([PY_DIR + "slice.py", rd, `${dir}/spec.json`, dir], 5 * 60 * 1000);
    if (r.code !== 0) { console.error(`slice ${f.slug} failed:`, r.err.trim().split("\n").pop()); writeFileSync(`${dir}/spec.json`, ""); continue; }
    n++;
  }
  return n;
}
/** Last-saved state of every control (lever/button) from disk, for when its chunk isn't loaded. */
async function sliceControls(srv: ServerId, mv: string, rd: string, force: boolean): Promise<number> {
  const cs = listFeatures(srv, mv, true).filter((f) => f.kind === "control" && f.x !== null && f.y !== null && f.z !== null);
  if (!cs.length) return 0;
  const dir = `${outDir(srv, mv)}/controls`;
  mkdirSync(dir, { recursive: true });
  const box = { from: [Math.min(...cs.map((f) => f.x!)) - 1, Math.min(...cs.map((f) => f.y!)) - 1, Math.min(...cs.map((f) => f.z!)) - 1], to: [Math.max(...cs.map((f) => f.x!)) + 1, Math.max(...cs.map((f) => f.y!)) + 1, Math.max(...cs.map((f) => f.z!)) + 1] };
  const specStr = JSON.stringify({ box, components_only: true });
  const prev = existsSync(`${dir}/spec.json`) ? readFileSync(`${dir}/spec.json`, "utf8") : "";
  let gen = 0;
  try { gen = Math.floor(statSync(`${dir}/components.json`).mtimeMs / 1000); } catch { /* none yet */ }
  const man = manifest(srv, mv);
  const changed = !gen || prev !== specStr || force || Object.values(man?.regions || {}).some((r) => r.mtime > gen);
  if (!changed) return 0;
  writeFileSync(`${dir}/spec.json`, specStr);
  const r = await runPy([PY_DIR + "slice.py", rd, `${dir}/spec.json`, dir], 5 * 60 * 1000);
  if (r.code !== 0) { console.error("controls slice failed:", r.err.trim().split("\n").pop()); writeFileSync(`${dir}/spec.json`, ""); return 0; }
  return cs.length;
}
/** On/off of each control: live from the server where its chunk is loaded, else the last save. */
async function controlStates(srv: ServerId, mv: string, cs: Feature[]): Promise<Record<string, { on: boolean | null; source: "live" | "save" | null; block: string | null }>> {
  const out: Record<string, { on: boolean | null; source: "live" | "save" | null; block: string | null }> = {};
  const disk = new Map((readJson<Array<[number, number, number, string]>>(`${outDir(srv, mv)}/controls/components.json`) || []).map((d) => [`${d[0]},${d[1]},${d[2]}`, d[3]]));
  let live: Array<string | null> = [];
  if (SERVERS[srv].modern && cs.length) {
    try { live = (await plugin("/states", { world: mv, positions: cs.map((f) => [f.x, f.y, f.z]) }, 5000, srv)).states || []; } catch { /* server down */ }
  }
  cs.forEach((f, i) => {
    const st = live[i] ?? disk.get(`${f.x},${f.y},${f.z}`) ?? null;
    const c = classify(st);
    out[f.id] = { on: c ? !!c[1] : null, source: live[i] ? "live" : st ? "save" : null, block: c ? c[2] : null };
  });
  return out;
}
let ticker: ReturnType<typeof setInterval> | null = null;
export function startMapRenderer(): void {
  if (ticker) return;
  const all = () => {
    for (const r of db.query("SELECT server, world FROM map_worlds WHERE enabled = 1").all() as Array<{ server: ServerId; world: string }>) {
      if (isEnabled(r.server)) enqueue(r.server, r.world, "schedule");
    }
  };
  setTimeout(all, 45_000);
  ticker = setInterval(all, RENDER_EVERY_MS);
}

// ── components (redstone etc.): classify a block state string ───────────────
// Codes match the area view: w wire, r repeater/comparator, t torch, B block,
// O observer/note/bell/hopper, L lamp/bulb, d daylight sensor, Z lightning rod,
// V lever, U button, D iron door/trapdoor, K piston, P plate, S sculk sensor,
// X tripwire/dispenser/dropper/crafter/target/tnt/trapped chest, R rail.
function parseState(st: string): { n: string; p: Record<string, string> } {
  const i = st.indexOf("[");
  const n = (i < 0 ? st : st.slice(0, i)).replace(/^minecraft:/, "");
  const p: Record<string, string> = {};
  if (i >= 0) for (const kv of st.slice(i + 1, -1).split(",")) { const [k, v] = kv.split("="); if (k) p[k] = v; }
  return { n, p };
}
export function classify(st: string | null): [string, number, string] | null {
  if (!st) return null;
  const { n, p } = parseState(st);
  const on = (k: string) => (p[k] === "true" ? 1 : 0);
  const pw = () => Number(p.power ?? 0) || 0;
  if (n === "redstone_wire") return ["w", pw(), n];
  if (n === "repeater" || n === "comparator") return ["r", on("powered"), n];
  if (n === "redstone_torch" || n === "redstone_wall_torch") return ["t", p.lit === "false" ? 0 : 1, n];
  if (n === "redstone_block") return ["B", 1, n];
  if (n === "redstone_lamp" || n.endsWith("copper_bulb")) return ["L", on("lit"), n];
  if (n === "daylight_detector") return ["d", pw(), n];
  if (n.endsWith("lightning_rod")) return ["Z", on("powered"), n];
  if (n === "lever") return ["V", on("powered"), n];
  if (n.endsWith("_button")) return ["U", on("powered"), n];
  if (n === "iron_door" || n === "iron_trapdoor") return ["D", on("open"), n];
  if (n === "piston" || n === "sticky_piston") return ["K", on("extended"), n];
  if (n === "piston_head") return ["K", 1, n];
  if (n.endsWith("pressure_plate")) return ["P", p.powered !== undefined ? on("powered") : pw() > 0 ? 1 : 0, n];
  if (n.endsWith("sculk_sensor")) return ["S", pw() > 0 || p.sculk_sensor_phase === "active" ? 1 : 0, n];
  if (n === "tripwire_hook" || n === "tripwire") return ["X", on("powered") || on("attached") ? on("powered") : 0, n];
  if (n === "dispenser" || n === "dropper" || n === "crafter") return ["X", on("triggered"), n];
  if (n === "target") return ["X", pw() > 0 ? 1 : 0, n];
  if (n === "tnt" || n === "trapped_chest") return ["X", 0, n];
  if (n === "observer") return ["O", on("powered"), n];
  if (n === "hopper") return ["O", p.enabled === "false" ? 1 : 0, n];
  if (n === "note_block" || n === "bell") return ["O", on("powered"), n];
  if (n === "rail" || n.endsWith("_rail")) return ["R", n === "rail" ? 0 : on("powered"), n];
  return null;
}
function inBox(x: number, y: number, z: number, b: { from: V3; to: V3 }): boolean {
  return x >= b.from[0] && x <= b.to[0] && y >= b.from[1] && y <= b.to[1] && z >= b.from[2] && z <= b.to[2];
}
const liveCache = new Map<string, { at: number; states: Array<string | null>; loaded: number }>();
interface AreaComps { comps: Array<[number, number, number, string, number, string]>; live: boolean; loaded: number; generated_at: number | null; meta: any }
async function areaComponents(srv: ServerId, mv: string, f: Feature, withSecret: boolean, fresh = false): Promise<AreaComps> {
  const dir = `${outDir(srv, mv)}/areas/${f.id}`;
  const meta = readJson<any>(`${dir}/floors.json`);
  const disk = readJson<Array<[number, number, number, string]>>(`${dir}/components.json`) || [];
  let states: Array<string | null> = disk.map((r) => r[3]);
  let live = false, loaded = 0;
  if (disk.length && SERVERS[srv].modern) {
    const key = f.id;
    const hit = liveCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 3000 && hit.states.length === Math.min(disk.length, 6000)) { states = disk.map((d, i) => hit.states[i] ?? d[3]); live = hit.loaded > 0; loaded = hit.loaded; }
    else {
      try {
        const r = await plugin("/states", { world: mv, positions: disk.slice(0, 6000).map((d) => [d[0], d[1], d[2]]) }, 8000, srv);
        const got: Array<string | null> = r.states || [];
        liveCache.set(key, { at: Date.now(), states: got, loaded: r.loaded || 0 });
        states = disk.map((d, i) => got[i] ?? d[3]);
        live = (r.loaded || 0) > 0; loaded = r.loaded || 0;
      } catch { /* server down or plugin missing: last save it is */ }
    }
  }
  const masks = withSecret ? [] : secretMasks(srv, mv);
  const comps: AreaComps["comps"] = [];
  disk.forEach((d, i) => {
    if (masks.some((m) => inBox(d[0], d[1], d[2], m))) return;
    const c = classify(states[i]);
    if (!c) return; // gone since the last slice
    comps.push([d[0], d[1], d[2], c[0], c[1], c[2]]);
  });
  return { comps, live, loaded, generated_at: meta?.generated_at ?? null, meta };
}

// ── MCP tool ─────────────────────────────────────────────────────────────────
export const MAP_TOOL = {
  name: "map",
  description: [
    "Keep the panel's Map tab current. Every world has a map (terrain rendered from the save) plus a features layer that YOU maintain: when you build or change a wall, tower, gate, building, passage, rail line or area, add or update it here.",
    "action 'list' (features + recent updates), 'add', 'update' (by id), 'remove' (by id). id is the feature's short id (slug, e.g. 'north-gate'), returned by add/list.",
    "kinds: wall (points), tower, gate, building, area, passage (set secret:true for hidden ones; owner/admin only see those), rail (points), place, planned (work not built yet), keepclear (box: nothing may be built there).",
    "Geometry: pos [x,y,z] for a marker (y = where a player stands there: the map's Teleport button goes to exactly this spot); points [[x,z],...] or [[x,y,z],...] for walls, passages and rail lines; box {from:[x,y,z], to:[x,y,z]} for an area/building/keep-clear zone.",
    "Drill-down floor plans: give a box (include every floor, basement to roof) and floors [{y, name}] (y = the floor block's y, standing level is y+1) or floors:'auto'. The map then cuts a plan at each floor and shows every lever, wire, lamp, piston, door, trap and rail in it, live. rooms [{name,x,z,y}] label rooms; levers [{pos:[x,y,z], name}] name the switchboard.",
    "Controls: every lever, button and trigger players can use gets kind 'control' with pos (the lever block itself) and control {group, type, reach, on, off, drives, verified}. The map reads its live state and lists it in the Controls card.",
    "Also: detail (one or two plain sentences for players), status ('Built', 'Building now', 'Planned', 'Protected'), underground:true for things below ground, note (what changed, shown in the Recent map updates feed).",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "update", "remove"] },
      world: { type: "string" },
      server: { type: "string", enum: ["1.8", "26"] },
      id: { type: "string", description: "Feature id (slug) for update/remove; optional custom id for add." },
      kind: { type: "string", enum: Object.keys(KINDS) },
      name: { type: "string" }, detail: { type: "string" }, status: { type: "string" }, note: { type: "string" },
      pos: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
      points: { type: "array", items: { type: "array", items: { type: "integer" } } },
      box: { type: "object", properties: { from: { type: "array", items: { type: "integer" } }, to: { type: "array", items: { type: "integer" } } } },
      floors: { description: "'auto' or [{y, name}]" },
      rooms: { type: "array", items: { type: "object" } },
      levers: { type: "array", items: { type: "object" } },
      secret: { type: "boolean" }, underground: { type: "boolean" },
      control: { type: "object", description: "kind 'control' only: {group (place, e.g. 'North Gate'), type ('lever'|'button'|'sensor'), reach (how to get to it), on (what ON does), off (what OFF does), drives (what it powers), verified (true once checked in the world)}" },
      filter_kind: { type: "string", description: "list: only this kind" },
    },
    required: ["action", "world"],
  },
};
function featureOut(f: Feature, masks: Array<{ from: V3; to: V3 }> = []) {
  const hide = (x: number, y: number | undefined, z: number) => masks.some((m) => inBox(x, y ?? (f.box ? f.box.from[1] : 0), z, m));
  const rooms = f.labels?.rooms?.filter((r) => !hide(r.x, r.y, r.z));
  const levers = f.labels?.levers ? Object.fromEntries(Object.entries(f.labels.levers).filter(([k]) => { const [x, y, z] = k.split(",").map(Number); return !hide(x, y, z); })) : undefined;
  return {
    id: f.slug, kind: f.kind, name: f.name, detail: f.detail || undefined, status: f.status || undefined,
    pos: f.x !== null ? [f.x, f.y, f.z] : undefined, points: f.points || undefined, box: f.box || undefined,
    floors: f.floors || undefined, rooms, levers, control: f.labels?.control,
    secret: f.secret || undefined, underground: f.underground || undefined, updated_at: new Date(f.updated_at * 1000).toISOString(),
  };
}
/** The `map` MCP tool, after mc-auth resolved the server and world. */
export async function mapTool(u: User, srv: ServerId, mv: string, a: any): Promise<any> {
  const w = getWorldByMv(mv, srv);
  if (!w || w.status !== "active") throw new Error(`Unknown world '${mv}' on the ${serverLabel(srv)} server.`);
  const priv = seesSecrets(userPrivileged(u, w));
  const action = String(a?.action ?? "list");
  if (action === "list") {
    let fs = listFeatures(srv, mv, priv);
    if (a?.filter_kind) fs = fs.filter((f) => f.kind === String(a.filter_kind));
    const ms = mapWorld(srv, mv);
    return {
      world: mv, server: serverLabel(srv), features: fs.map((f) => featureOut(f, priv ? [] : secretMasks(srv, mv))),
      recent: recentUpdates(srv, mv, priv, 8).map((r) => ({ id: r.slug, action: r.action, title: r.title, what: r.what, by: r.actor, at: new Date(r.at * 1000).toISOString() })),
      terrain: ms ? { status: ms.status, rendered_at: ms.rendered_at ? new Date(ms.rendered_at * 1000).toISOString() : null } : "not mapped yet (adding a feature turns the map on)",
      page: `${config.publicBaseUrl}/map/${srv}/${mv}`,
      note: priv ? undefined : "Secret passages are only listed for the world's owner and admins.",
    };
  }
  const touchesSecret = (f: Feature | null) => !!f?.secret || (a?.secret !== undefined && truthy(a.secret));
  if (action === "add") {
    if (touchesSecret(null) && !priv) throw new Error("Only the world's owner or an admin can add secret passages.");
    const f = addFeature(srv, mv, { ...a, slug: a?.id }, u.username, a?.note ? String(a.note) : undefined);
    if (!mapWorld(srv, mv)) enqueue(srv, mv, "first feature");
    return { added: featureOut(f), page: `${config.publicBaseUrl}/map/${srv}/${mv}` };
  }
  const id = String(a?.id ?? "").trim();
  if (!id) throw new Error("id is required for update/remove (see list).");
  const cur = getFeature(srv, mv, id);
  if (!cur || (cur.secret && !priv)) throw new Error(`No feature '${id}' in ${mv}.`);
  if (touchesSecret(cur) && !priv) throw new Error("Only the world's owner or an admin can change secret passages.");
  if (action === "update") {
    const { id: _id, slug: _s, ...rest } = a || {};
    const f = updateFeature(srv, mv, cur.id, { ...rest, slug: a?.new_id }, u.username, a?.note ? String(a.note) : undefined);
    return { updated: featureOut(f) };
  }
  if (action === "remove") {
    const f = removeFeature(srv, mv, cur.id, u.username, a?.note ? String(a.note) : undefined);
    return { removed: f.slug };
  }
  throw new Error("action must be list, add, update or remove.");
}

// ── pages + JSON API ─────────────────────────────────────────────────────────
const ASSET_V = String(Date.now());
const NO_STORE = { "Cache-Control": "private, no-store" };
function worldFromParams(c: Context): { srv: ServerId; mv: string; w: World } | null {
  const srv = parseServer(c.req.param("srv"));
  const mv = String(c.req.param("world") || "");
  if (!srv || !isEnabled(srv) || !MV_RE.test(mv)) return null;
  const w = getWorldByMv(mv, srv);
  if (!w || w.status !== "active") return null;
  return { srv, mv, w };
}
function mapWorldsList() {
  const rows = new Map((db.query("SELECT server, world, status, rendered_at FROM map_worlds WHERE enabled = 1").all() as any[]).map((r) => [`${r.server}/${r.world}`, r]));
  return listAllWorlds()
    .filter((w) => w.status === "active" && isEnabled(w.server))
    .map((w) => ({ server: w.server, serverLabel: serverLabel(w.server), mv: w.mv_world_name, name: w.name, mapped: rows.has(`${w.server}/${w.mv_world_name}`) }))
    .sort((a, b) => (a.server === b.server ? 0 : a.server === "26" ? -1 : 1) || Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name));
}
function featureJson(f: Feature) {
  return {
    id: f.id, slug: f.slug, kind: f.kind, kindLabel: KINDS[f.kind]?.label ?? f.kind, name: f.name, detail: f.detail, status: f.status,
    x: f.x, y: f.y, z: f.z, points: f.points, box: f.box, secret: f.secret, underground: f.underground,
    drill: !!(f.box && f.floors), updated_at: f.updated_at, control: f.kind === "control" ? (f.labels?.control || {}) : undefined,
  };
}
function jsonErr(c: Context, status: number, error: string) { return c.json({ error }, status as any, NO_STORE); }
function sameOrigin(c: Context): boolean {
  const o = c.req.header("origin");
  if (!o) return true; // same-origin fetches from older browsers; the cookie is SameSite=Lax anyway
  try { return new URL(o).host === new URL(config.publicBaseUrl).host || new URL(o).host === c.req.header("host"); } catch { return false; }
}

function mapShell(v: Viewer, title: string, boot: any, body: string): string {
  const head = `<link rel="stylesheet" href="/map/assets/leaflet.css?v=${ASSET_V}"/><link rel="stylesheet" href="/map/assets/map.css?v=${ASSET_V}"/>`;
  const scripts = `<script>window.MAP_BOOT=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script><script src="/map/assets/leaflet.js?v=${ASSET_V}"></script><script src="/map/assets/map.js?v=${ASSET_V}"></script>`;
  return shell({ title, active: "map", username: v.username, admin: v.admin, full: true, body: head + body + scripts });
}
/** A card that floats over the map; its header collapses it. */
function mapCard(id: string, title: string, inner: string): string {
  return `<section class="mpc" data-card="${id}" aria-label="${esc(title)}"><button type="button" class="mpc-h" aria-expanded="true" aria-controls="mpc-${id}"><span>${esc(title)}</span><svg class="mpc-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="mpc-b" id="mpc-${id}">${inner}</div></section>`;
}
function worldSelect(cur: { srv: ServerId; mv: string }): string {
  const opts = mapWorldsList().map((w) => `<option value="/map/${w.server}/${esc(w.mv)}"${w.server === cur.srv && w.mv === cur.mv ? " selected" : ""}>${esc(w.name)} · ${esc(w.serverLabel)}${w.mapped ? "" : " (no map yet)"}</option>`).join("");
  return `<label class="mp-world">World<select id="mp-world" aria-label="World">${opts}</select></label>`;
}

export function mountMap(app: Hono): void {
  // assets: Leaflet (vendored from node_modules) + the map client
  const LEAFLET = new URL("../node_modules/leaflet/dist/", import.meta.url).pathname;
  const PUB = new URL("../public/", import.meta.url).pathname;
  const asset = (file: string, type: string) => async (c: Context) => {
    if (!(await currentSession(c))) return c.text("unauthorized", 401);
    const f = Bun.file(file);
    if (!(await f.exists())) return c.text("not found", 404);
    return new Response(f, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
  };
  app.get("/map/assets/leaflet.js", asset(LEAFLET + "leaflet.js", "text/javascript; charset=utf-8"));
  app.get("/map/assets/leaflet.css", asset(LEAFLET + "leaflet.css", "text/css; charset=utf-8"));
  app.get("/map/assets/map.js", asset(PUB + "map.js", "text/javascript; charset=utf-8"));
  app.get("/map/assets/map.css", asset(PUB + "map.css", "text/css; charset=utf-8"));

  // Must come before /map/:srv/:world, which would otherwise swallow it.
  app.get("/map/api/ack", (c) => c.json({ msg: c.req.query("msg") || null, err: c.req.query("err") || null }, 200, NO_STORE));

  app.get("/map", async (c) => {
    const v = await viewer(c); if (!v) return c.redirect("/login");
    const list = mapWorldsList();
    const pick = list.find((w) => w.server === "26" && w.mv === "homeland" && w.mapped) || list.find((w) => w.mapped) || list[0];
    if (!pick) return c.html(shell({ title: "Map", active: "map", username: v.username, admin: v.admin, body: pageHead({ eyebrow: "Map", title: "Map", sub: "No worlds yet." }) }));
    return c.redirect(`/map/${pick.server}/${pick.mv}`);
  });

  app.get("/map/:srv/:world", async (c) => {
    const v = await viewer(c); if (!v) return c.redirect("/login");
    const ww = worldFromParams(c);
    if (!ww) return c.redirect("/map");
    const { srv, mv, w } = ww;
    const boot = { mode: "world", srv, srvLabel: serverLabel(srv), mv, worldId: w.id, api: `/map/api/${srv}/${mv}` };
    const body = `
<div class="mpf" id="mpf">
  <div class="mpf-map" id="mp-map" role="application" aria-label="Map of ${esc(w.name)}. Drag to pan, scroll or pinch to zoom."></div>
  <div class="mpf-top">
    <div class="mpf-title"><span class="eyebrow">Map</span><b>${esc(w.name)}</b> ${edBadge(srv)}</div>
    <div class="mp-search" role="search"><input id="mp-search" type="search" placeholder="Search the map" aria-label="Search the map: a place, gate, lever, tower, or coordinates" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="mp-results" enterkeyhint="search"/><kbd aria-hidden="true">/</kbd><div id="mp-results" class="mp-results" role="listbox" hidden></div></div>
    ${worldSelect({ srv, mv })}
    <div class="mp-status" id="mp-status">Loading…</div>
    <button type="button" class="mpf-btn" id="mp-view" hidden aria-pressed="false">Top-down</button>
    <button type="button" class="mpf-btn" id="mp-render">Render now</button>
    <button type="button" class="mpf-btn" id="mpf-cards" aria-pressed="false">Hide cards</button>
    <button type="button" class="mpf-btn mpf-q" id="mp-help-btn" aria-label="How to use the map" title="How to use the map">?</button>
  </div>
  <div class="mpf-col mpf-left">
    ${mapCard("help", "How to use", `<div class="mp-help">
<p><b>Move</b> Drag to pan (one finger on a phone). Scroll or pinch to zoom. <span class="k">+</span> <span class="k">−</span> zoom and <span class="k">⤢</span> fits everything.</p>
<p><b>3D and top-down</b> The <span class="k">3D</span> / <span class="k">Top-down</span> button switches view. In 3D, drag to move, right-drag or two fingers to turn and tilt. Its bar at the bottom left: <span class="k">☰</span> menu (marker sets on and off, settings, flat or free-flight views), view buttons, and your position.</p>
<p><b>Search</b> The box at the top (press <span class="k">/</span>) finds gates, levers, towers, areas and your places by name or kind: try <i>north gate lever</i> or just <i>lever</i>. Coordinates like <code>310 146</code> or <code>310 78 146</code> jump there.</p>
<p><b>Select</b> Click any marker to show it in <i>Selected</i>: <i>Teleport here</i> (you must be in the game on that server), <i>Save as place</i>, and for areas <i>Open floor plans and power</i>.</p>
<p><b>Layers</b> Gates, buildings and places show at first. Towers, controls, rails, planned work and keep-clear zones say <i>Auto</i>: they appear once you zoom in close; click a layer to switch it On or Off for good. Numbered bubbles are several markers close together: click one to zoom in. In 3D, use the ☰ menu.</p>
<p><b>Controls</b> The <i>Controls</i> card lists every lever and button by place: how to reach it, what ON and OFF do, what it drives, and whether it is on right now. <i>Show on map</i> jumps to it.</p>
<p><b>Floor plans and power</b> Floor tabs pick the level. Pick a lever to light up the wire, lamps, pistons and doors it drives. <i>Flip in the game</i> switches the real lever (world owner and admins only), then the map reads the new state back.</p>
<div class="mp-legend">
<span><i class="lg sq" style="background:#46d17f"></i>Gate · wall (line)</span><span><i class="lg sq" style="background:#e6e9ee"></i>Tower</span>
<span><i class="lg" style="background:#ffb454"></i>Building · area (box)</span><span><i class="lg" style="background:#c08cff"></i>Underground · rail (dashed)</span>
<span><i class="lg" style="background:#5aa9ff"></i>Place</span><span><i class="lg sq" style="background:#ffd166"></i>Planned (dashed)</span>
<span><i class="lg" style="background:#ff6b6b"></i>Keep clear (dashed box)</span><span><i class="lg dm" style="background:#e3b34a"></i>Control (lever, button)</span>
<span><i class="lg" style="background:#ff8ad8"></i>Secret passage</span>
</div>
</div>
`)}
    ${mapCard("sel", "Selected", `<div id="mp-sel"><p class="muted" style="margin:0">Click a tower, gate, building or place on the map.</p></div>`)}
    ${mapCard("controls", "Controls", `<p class="hint" style="margin:0 0 .5rem;font-size:.8rem">No switch to look for: the night lamps on every wall and tower crown, the lighthouse lantern rings and balcony beacons, the harbour merlons and the dock lamps come on at dusk (daylight sensors); the gate and postern motion lights react to movement; the lighthouse lens is always lit.</p><div id="mp-controls"><p class="muted" style="margin:0">Loading…</p></div>`)}
  </div>
  <div class="mpf-col mpf-right">
    ${mapCard("layers", "Layers", `<div class="mp-layers" id="mp-layers"></div>`)}
    ${mapCard("key", "Terrain colours", `<div class="mp-key" id="mp-key"></div><p class="hint" style="margin:.6rem 0 0;font-size:.78rem">Same colours as a Minecraft map. Slopes are lighter facing north, darker facing south.</p>`)}
    ${mapCard("updates", "Recent map updates", `<div class="mp-updates" id="mp-updates"></div>`)}
  </div>
  <div class="mpf-coords"><span class="mp-coords" id="mp-coords" aria-live="polite">Hover or tap the map for coordinates</span><span class="mp-hint" id="mp-zoom"></span></div>
</div>`;
    c.header("Cache-Control", "no-store");
    return c.html(mapShell(v, `Map · ${w.name}`, boot, body));
  });

  app.get("/map/:srv/:world/area/:fid", async (c) => {
    const v = await viewer(c); if (!v) return c.redirect("/login");
    const ww = worldFromParams(c);
    if (!ww) return c.redirect("/map");
    const { srv, mv, w } = ww;
    const f = getFeature(srv, mv, c.req.param("fid"));
    const priv = seesSecrets(privileged(v, w));
    if (!f || (f.secret && !priv) || !f.box || !f.floors) return c.redirect(`/map/${srv}/${mv}`);
    const boot = { mode: "area", srv, srvLabel: serverLabel(srv), mv, worldId: w.id, fid: f.id, api: `/map/api/${srv}/${mv}/area/${f.id}`, back: `/map/${srv}/${mv}` };
    const body = `
<div class="mpf" id="mpf">
  <div class="mpf-map mp-plan" id="mp-map" role="application" aria-label="Floor plan of ${esc(f.name)}. Drag to pan, scroll or pinch to zoom."></div>
  <div class="mpf-top">
    <div class="mpf-title"><a class="eyebrow" href="/map/${srv}/${esc(mv)}">${esc(w.name)} map</a><b>${esc(f.name)}</b></div>
    <a class="mpf-btn" href="/map/${srv}/${esc(mv)}">Back to the map</a>
    <div class="mp-status" id="mp-status">Loading…</div>
    <button type="button" class="mpf-btn" id="mpf-cards" aria-pressed="false">Hide cards</button>
    <button type="button" class="mpf-btn mpf-q" id="mp-help-btn" aria-label="How to use the floor plans" title="How to use the floor plans">?</button>
  </div>
  <div class="mpf-floors" role="tablist" aria-label="Floor" id="mp-floors"></div>
  <div class="mpf-col mpf-right">
    ${mapCard("help", "How to use", `<div class="mp-help">
<p><b>Move</b> Drag to pan, scroll or pinch to zoom, <span class="k">⤢</span> fits the whole area.</p>
<p><b>Floors</b> The tabs along the top pick the level. The plan is cut at head height: darker blocks are walls, bright ones are floor.</p>
<p><b>Layers</b> <i>On this floor</i> turns power lines, lights, levers and buttons, doors and pistons, traps and triggers, rails, room names and the block grid on and off.</p>
<p><b>Trace power</b> Click a lever on the plan, or a row in the <i>Switchboard</i>. What it drives lights up and everything else fades. Counts show wire, lamps, pistons and doors.</p>
<p><b>Flip</b> <i>Flip in the game</i> switches the real lever (world owner and admins only) and reads the new state back a moment later.</p>
<div class="mp-legend">
<span><i class="lg" style="background:#ff6a28"></i>Wire (brighter = stronger)</span><span><i class="lg sq" style="background:#ffe28a"></i>Lamp lit</span>
<span><i class="lg sq" style="background:#4a3a20"></i>Lamp off</span><span><i class="lg sq" style="background:#ff8a3d"></i>Repeater on</span>
<span><i class="lg sq" style="background:#9be37d"></i>Piston out</span><span><i class="lg sq" style="background:#ffffff"></i>Door open</span>
<span><i class="lg" style="background:#ff5c93"></i>Plate · trigger</span><span><i class="lg" style="background:#2fb5c9"></i>Sculk sensor</span>
<span><i class="lg sq" style="background:#46d17f"></i>Lever on</span><span><i class="lg" style="background:#ffd76a"></i>Powered rail</span>
</div>
</div>
`)}
    ${mapCard("lever", "Lever", `<div id="mp-lever"><p class="muted" style="margin:0">Loading…</p></div>`)}
    ${mapCard("switch", "Switchboard", `<div class="mp-switch" id="mp-switch"></div>`)}
    ${mapCard("floor", "On this floor", `<div class="mp-layers" id="mp-layers"></div><p class="hint" style="margin:.6rem 0 0;font-size:.78rem">Plan cut at head height. Darker blocks are walls. One square is one block.</p>`)}
  </div>
  <div class="mpf-coords"><span class="mp-coords" id="mp-coords" aria-live="polite">Hover or tap the plan for coordinates</span><span class="mp-hint" id="mp-live"></span></div>
</div>`;
    c.header("Cache-Control", "no-store");
    return c.html(mapShell(v, `${f.name} · Map`, boot, body));
  });

  // ── JSON: world map ──
  app.get("/map/api/:srv/:world", async (c) => {
    const v = await viewer(c); if (!v) return jsonErr(c, 401, "Sign in first.");
    const ww = worldFromParams(c);
    if (!ww) return jsonErr(c, 404, "Unknown world.");
    const { srv, mv, w } = ww;
    const isPriv = privileged(v, w);
    const priv = seesSecrets(isPriv);
    const ms = mapWorld(srv, mv);
    const man = manifest(srv, mv);
    const updates = recentUpdates(srv, mv, priv, 12);
    const bm = srv === "26" && blueMapProbe ? (await blueMapProbe()).includes(mv) : false;
    return c.json({
      bluemap: bm,
      world: { id: w.id, name: w.name, mv, server: srv, serverLabel: serverLabel(srv) },
      privileged: isPriv,
      map: ms ? {
        status: running === `${srv}/${mv}` ? "rendering" : ms.status, rendered_at: man?.rendered_at ?? ms.rendered_at, requested_at: ms.requested_at,
        bounds: man?.bounds ?? null, min_zoom: man?.min_zoom ?? -2, pending: man?.pending ?? 0, tiles: man?.tiles ?? {},
      } : null,
      features: await (async () => {
        const fs = listFeatures(srv, mv, priv);
        const st = await controlStates(srv, mv, fs.filter((f) => f.kind === "control" && f.x !== null && f.y !== null && f.z !== null));
        return fs.map((f) => ({ ...featureJson(f), state: st[f.id] }));
      })(),
      places: listSavedLocations(v.sub, srv, mv).map((p) => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z })),
      updates: updates.map((u) => ({ ...u, feature: u.feature_id })),
    }, 200, NO_STORE);
  });
  app.post("/map/api/:srv/:world/render", async (c) => {
    const v = await viewer(c); if (!v) return jsonErr(c, 401, "Sign in first.");
    if (!sameOrigin(c)) return jsonErr(c, 403, "Bad origin.");
    const ww = worldFromParams(c);
    if (!ww) return jsonErr(c, 404, "Unknown world.");
    const { srv, mv, w } = ww;
    const priv = privileged(v, w);
    if (rateLimited(`maprender:${v.sub}`, priv ? 6 : 2, 300)) return jsonErr(c, 429, "Give it a few minutes before asking again.");
    if (!priv && !mapWorld(srv, mv)?.enabled) return jsonErr(c, 403, "Only the world's owner or an admin can turn on the map for a world. Ask them to hit Map this world.");
    const force = priv && c.req.query("force") === "1";
    if (priv && SERVERS[srv].modern) { try { await rcon("save-all", 8000, srv); await new Promise((r) => setTimeout(r, 2500)); } catch { /* render the last autosave */ } }
    enqueue(srv, mv, `requested by ${v.username}`, force);
    return c.json({ ok: true, queued: true }, 200, NO_STORE);
  });
  app.get("/map/tiles/:srv/:world/:z/:file", async (c) => {
    if (!(await currentSession(c))) return c.text("unauthorized", 401);
    const srv = parseServer(c.req.param("srv")); const mv = c.req.param("world"); const z = c.req.param("z"); const file = c.req.param("file");
    if (!srv || !MV_RE.test(mv) || !/^-?\d{1,2}$/.test(z) || !/^-?\d{1,5}_-?\d{1,5}\.png$/.test(file)) return c.text("bad request", 400);
    const f = Bun.file(`${outDir(srv, mv)}/tiles/${z}/${file}`);
    if (!(await f.exists())) return c.text("not found", 404);
    return new Response(f, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } });
  });

  // ── JSON: area (floor plans + live components) ──
  app.get("/map/api/:srv/:world/area/:fid", async (c) => {
    const v = await viewer(c); if (!v) return jsonErr(c, 401, "Sign in first.");
    const ww = worldFromParams(c);
    if (!ww) return jsonErr(c, 404, "Unknown world.");
    const { srv, mv, w } = ww;
    const isPriv = privileged(v, w);
    const priv = seesSecrets(isPriv);
    const f = getFeature(srv, mv, c.req.param("fid"));
    if (!f || (f.secret && !priv) || !f.box || !f.floors) return jsonErr(c, 404, "No such area.");
    const ac = await areaComponents(srv, mv, f, priv, isPriv && c.req.query("fresh") === "1");
    const names = new Map((Array.isArray(f.floors) ? f.floors : []).map((x) => [x.y, x.name]));
    const floorsY: number[] = ac.meta?.floors ?? (Array.isArray(f.floors) ? f.floors.map((x) => x.y) : []);
    const ver = ac.generated_at ?? 0;
    const masks = priv ? [] : secretMasks(srv, mv);
    const rooms = (f.labels?.rooms || []).filter((r) => !masks.some((m) => inBox(r.x, r.y ?? f.box!.from[1], r.z, m)));
    const levers = Object.fromEntries(Object.entries(f.labels?.levers || {}).filter(([k]) => { const [x, y, z] = k.split(",").map(Number); return !masks.some((m) => inBox(x, y, z, m)); }));
    const ms = mapWorld(srv, mv);
    return c.json({
      area: { ...featureJson(f), rooms, levers },
      box: f.box, privileged: isPriv, canFlip: isPriv && SERVERS[srv].modern,
      floors: floorsY.map((y) => ({ y, name: names.get(y) || `Level ${y}`, img: `/map/plans/${srv}/${mv}/${f.id}/${y}.png?v=${ver}${priv ? "f" : "p"}` })),
      comps: ac.comps, live: ac.live, loaded: ac.loaded, generated_at: ac.generated_at,
      status: ac.meta ? "ok" : (ms ? (running === `${srv}/${mv}` ? "rendering" : ms.status) : "new"),
    }, 200, NO_STORE);
  });
  app.get("/map/plans/:srv/:world/:fid/:file", async (c) => {
    const v = await viewer(c); if (!v) return c.text("unauthorized", 401);
    const ww = worldFromParams(c);
    if (!ww) return c.text("not found", 404);
    const { srv, mv, w } = ww;
    const m = /^(-?\d{1,3})\.png$/.exec(c.req.param("file"));
    const f = getFeature(srv, mv, c.req.param("fid"));
    const priv = seesSecrets(privileged(v, w));
    if (!m || !f || (f.secret && !priv)) return c.text("not found", 404);
    const dir = `${outDir(srv, mv)}/areas/${f.id}`;
    const file = Bun.file(`${dir}/floor_${m[1]}${priv ? "" : "_pub"}.png`);
    if (!(await file.exists())) return c.text("not found", 404);
    return new Response(file, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
  });
  app.post("/map/api/:srv/:world/area/:fid/lever", async (c) => {
    const v = await viewer(c); if (!v) return jsonErr(c, 401, "Sign in first.");
    if (!sameOrigin(c)) return jsonErr(c, 403, "Bad origin.");
    const ww = worldFromParams(c);
    if (!ww) return jsonErr(c, 404, "World not found.");
    const { srv, mv, w } = ww;
    // Same gates as the Command Center (signed in, world exists and is active, the
    // lobby is admin-only), plus: only the world's owner or an admin flips levers.
    if (isLobby(mv) && !v.admin) return jsonErr(c, 403, "The lobby's controls are admin-only.");
    if (!privileged(v, w)) return jsonErr(c, 403, "Only the world's owner and admins can flip levers.");
    if (!SERVERS[srv].modern) return jsonErr(c, 400, "Lever control is only on the 26 server.");
    const f = getFeature(srv, mv, c.req.param("fid"));
    if (!f || !f.box || !f.floors) return jsonErr(c, 404, "No such area.");
    if (rateLimited(`maplever:${v.sub}`, 20, 30)) return jsonErr(c, 429, "Easy on the levers. Try again in a moment.");
    let body: any = {};
    try { body = await c.req.json(); } catch { return jsonErr(c, 400, "Send JSON {x, y, z}."); }
    const x = Number(body?.x), y = Number(body?.y), z = Number(body?.z);
    if (![x, y, z].every(Number.isInteger) || !inBox(x, y, z, f.box)) return jsonErr(c, 400, "That position isn't in this area.");
    // Only a lever the map knows about (the area's inventory) can be flipped from here.
    const disk = readJson<Array<[number, number, number, string]>>(`${outDir(srv, mv)}/areas/${f.id}/components.json`) || [];
    if (!disk.some((d) => d[0] === x && d[1] === y && d[2] === z && classify(d[3])?.[0] === "V")) return jsonErr(c, 400, "There's no mapped lever there.");
    let res: any;
    try { res = await plugin("/lever", { world: mv, pos: [x, y, z], powered: typeof body?.powered === "boolean" ? body.powered : undefined }, 8000, srv); }
    catch (e: any) { return jsonErr(c, 502, "The game server didn't take it: " + (e?.message || e)); }
    console.log(`map lever ${srv}/${mv} ${x} ${y} ${z} -> ${res?.powered} by ${v.username} (${res?.method})`);
    await new Promise((r) => setTimeout(r, 400)); // let repeaters and pistons tick
    const ac = await areaComponents(srv, mv, f, true, true);
    return c.json({ ok: true, powered: !!res?.powered, method: res?.method, comps: ac.comps, live: ac.live, loaded: ac.loaded }, 200, NO_STORE);
  });
}

// Make sure the output root exists (the volume is owned by the panel's user).
try { mkdirSync(MAP_DIR, { recursive: true }); } catch { /* read-only dev checkout */ }
