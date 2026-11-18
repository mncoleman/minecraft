// BlueMap: the Map tab's 3D world view on the 26 server.
//
//   * BlueMap runs inside mc-eagler26. Its web server (port 8100) is not published;
//     mc-auth proxies it at /map/3d/ for signed-in players only (GET, allowlisted
//     paths, private caching, bytes passed through still compressed).
//   * mc-auth writes BlueMap's per-world map config (maps/<world>.conf) for every
//     26 world the Map tab has turned on. If secrets are made private again
//     (map.ts SECRETS_PRIVATE), secret boxes are cut out of the 3D render with
//     subtract render-masks; today the whole world renders.
//   * Features (map_features, the source of truth) are pushed as BlueMap markers
//     through ClaudeBuild's /bluemap_markers (secret ones only while secrets are public).
import type { Hono, Context } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { currentSession } from "./session.ts";
import { db } from "./db.ts";
import { SERVERS, isEnabled, type ServerId } from "./servers.ts";
import { getWorldByMv, dimensionKey } from "./worlds.ts";
import { rcon } from "./rcon.ts";
import { plugin } from "./buildapi.ts";
import { listFeatures, secretMasks, setFeatureListener, KINDS, SECRETS_PRIVATE, type Feature } from "./map.ts";

const SRV: ServerId = "26";
const MV_RE = /^[A-Za-z0-9_-]{1,32}$/;
const upstream = () => `http://${SERVERS[SRV].host}:${Number(process.env.BLUEMAP26_PORT || 8100)}`;
const bmDir = () => `${SERVERS[SRV].gamedataDir}/plugins/BlueMap`;

/** 26 worlds whose map is on (map_worlds.enabled). */
function mappedWorlds(): string[] {
  return (db.query("SELECT world FROM map_worlds WHERE server = '26' AND enabled = 1").all() as Array<{ world: string }>)
    .map((r) => r.world).filter((w) => MV_RE.test(w) && w !== "world" && !!getWorldByMv(w, SRV));
}

// ── map configs (with secret masks) ──────────────────────────────────────────
function hstr(s: string): string { return JSON.stringify(s); }
function mapConf(mv: string): string {
  const w = getWorldByMv(mv, SRV);
  const fs = listFeatures(SRV, mv, true);
  const anchor = fs.find((f) => f.kind === "area" && f.x !== null) || fs.find((f) => f.x !== null);
  const masks = (SECRETS_PRIVATE ? secretMasks(SRV, mv) : []).map((m) =>
    `  { subtract: true, min-x: ${m.from[0] - 1}, max-x: ${m.to[0] + 1}, min-y: ${m.from[1] - 1}, max-y: ${m.to[1] + 1}, min-z: ${m.from[2] - 1}, max-z: ${m.to[2] + 1} }`);
  return `## Written by mc-auth (auth/src/bluemap.ts). Edits here are overwritten.
## Secret passages are subtracted only while the panel keeps secrets private.
world: "world"
dimension: ${hstr(dimensionKey(mv))}
name: ${hstr(w?.name || mv)}
sorting: 0
start-pos: { x: ${anchor?.x ?? 0}, z: ${anchor?.z ?? 0} }
sky-color: "#7dabff"
void-color: "#000000"
sky-light: 1
ambient-light: 0.1
remove-caves-below-y: 55
cave-detection-ocean-floor: -5
cave-detection-uses-block-light: false
min-inhabited-time: 0
render-mask: [
  {}
${masks.join("\n")}
]
render-edges: false
edge-light-strength: 8
enable-perspective-view: true
enable-flat-view: true
enable-free-flight-view: true
enable-hires: true
storage: "file"
ignore-missing-light-data: false
marker-sets: {}
`;
}
/** Write maps/<world>.conf for each mapped 26 world. Returns true if anything changed. */
export function syncBlueMapConfigs(): boolean {
  const dir = bmDir();
  if (!existsSync(dir)) return false; // BlueMap not installed
  mkdirSync(`${dir}/maps`, { recursive: true });
  let changed = false;
  for (const mv of mappedWorlds()) {
    const p = `${dir}/maps/${mv}.conf`;
    const want = mapConf(mv);
    let have = "";
    try { have = readFileSync(p, "utf8"); } catch { /* new */ }
    if (have !== want) { writeFileSync(p + ".tmp", want); renameSync(p + ".tmp", p); changed = true; }
  }
  return changed;
}
async function reloadBlueMap(): Promise<void> {
  try { await rcon("bluemap reload light", 30000, SRV); } catch (e: any) { console.error("bluemap reload failed:", e?.message || e); }
}

// ── markers ──────────────────────────────────────────────────────────────────
const COLORS: Record<string, string> = {
  wall: "#46d17f", tower: "#e6e9ee", gate: "#46d17f", building: "#ffb454", area: "#ffb454",
  passage: "#c08cff", rail: "#c08cff", place: "#5aa9ff", planned: "#ffd166", keepclear: "#ff6b6b",
};
const SETS: Array<[string, string, (f: Feature) => boolean]> = [
  ["walls", "Walls, towers, gates", (f) => ["wall", "tower", "gate"].includes(f.kind) && !f.underground],
  ["buildings", "Buildings and areas", (f) => ["building", "area"].includes(f.kind) && !f.underground],
  ["underground", "Underground and rails", (f) => f.underground || f.kind === "passage" || f.kind === "rail"],
  ["places", "Places", (f) => f.kind === "place" && !f.underground],
  ["planned", "Planned", (f) => f.kind === "planned"],
  ["keepclear", "Keep clear", (f) => f.kind === "keepclear"],
];
function esc(s: string): string { return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function detailHtml(f: Feature, mv: string): string {
  const drill = f.box && f.floors ? `<div style="margin-top:6px"><a href="/map/26/${mv}/area/${encodeURIComponent(f.slug)}" target="_top">Open floor plans and power</a></div>` : "";
  return `<div style="max-width:260px" data-mp-f="${esc(f.slug)}"><div style="font-weight:700">${esc(f.name)}</div><div style="opacity:.75;font-size:.85em">${esc(KINDS[f.kind]?.label || f.kind)}${f.status ? " · " + esc(f.status) : ""}</div>${f.detail ? `<div style="margin-top:4px">${esc(f.detail)}</div>` : ""}${drill}</div>`;
}
function markersFor(mv: string) {
  const fs = listFeatures(SRV, mv, !SECRETS_PRIVATE); // secret ones only when secrets are public
  return SETS.map(([id, label, pick], i) => ({
    id, label, sorting: i,
    markers: fs.filter(pick).flatMap((f) => {
      const color = COLORS[f.kind] || "#46d17f";
      const out: any[] = [];
      const yDef = f.y ?? (f.box ? f.box.to[1] : 70);
      if (f.points && f.points.length > 1) {
        out.push({ id: f.slug + "-line", type: "line", label: esc(f.name), detail: detailHtml(f, mv), color, width: f.kind === "wall" ? 4 : 3,
          points: f.points.map((p) => p.length === 3 ? [p[0] + 0.5, p[1] + 1.5, p[2] + 0.5] : [p[0] + 0.5, yDef + 1.5, p[1] + 0.5]) });
      }
      if (f.box) {
        out.push({ id: f.slug + "-area", type: "area", label: esc(f.name), detail: detailHtml(f, mv), color, fill: f.kind === "keepclear" ? 0.08 : 0.1, width: 2,
          rect: [f.box.from[0], f.box.from[2], f.box.to[0] + 1, f.box.to[2] + 1], y: (f.y ?? f.box.from[1]) + 0.5 });
      }
      const lineOnly = (f.kind === "wall" || f.kind === "rail" || f.kind === "passage") && f.points && f.points.length > 1;
      if (f.x !== null && f.z !== null && !lineOnly) {
        out.push({ id: f.slug, type: "poi", label: esc(f.name), detail: detailHtml(f, mv), pos: [f.x + 0.5, (f.y ?? yDef) + 1, f.z + 0.5],
          icon: `/map/assets/poi/${f.kind}.svg`, maxDistance: f.kind === "tower" || f.kind === "place" ? 1500 : 100000 });
      }
      return out;
    }),
  }));
}
export async function pushMarkers(mv: string): Promise<{ ok: boolean; applied?: number; error?: string }> {
  if (!isEnabled(SRV)) return { ok: false, error: "26 server off" };
  try {
    const r = await plugin("/bluemap_markers", { map: mv, sets: markersFor(mv) }, 15000, SRV);
    return { ok: true, applied: r.applied };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

// Feature changes: re-push markers (debounced); a secret change also rewrites the
// render mask and reloads BlueMap so the passage is cut out of the 3D view.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSecret = new Set<string>();
setFeatureListener((srv, mv, secretChanged) => {
  if (srv !== SRV) return;
  if (secretChanged) pendingSecret.add(mv);  // sticky: a later plain change in the window keeps it
  clearTimeout(pending.get(mv));
  pending.set(mv, setTimeout(async () => {
    pending.delete(mv);
    const secret = pendingSecret.delete(mv);
    if ((secret || !existsSync(`${bmDir()}/maps/${mv}.conf`)) && syncBlueMapConfigs()) await reloadBlueMap();
    await pushMarkers(mv);
  }, 2000));
});
/** Boot + every 10 minutes: configs in place, markers current. */
export function startBlueMapSync(): void {
  const tick = async () => {
    if (!isEnabled(SRV)) return;
    if (syncBlueMapConfigs()) await reloadBlueMap();
    for (const mv of mappedWorlds()) await pushMarkers(mv);
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 10 * 60 * 1000);
}

// ── is a world on BlueMap yet? (settings.json lists the loaded maps) ─────────
let settingsCache: { at: number; maps: string[] } | null = null;
export async function blueMapMaps(): Promise<string[]> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.maps;
  let maps: string[] = [];
  try {
    const r = await fetch(`${upstream()}/settings.json`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { const j: any = await r.json(); maps = Array.isArray(j?.maps) ? j.maps.map((m: any) => (typeof m === "string" ? m : m?.id)).filter(Boolean) : []; }
  } catch { /* BlueMap down or not installed */ }
  settingsCache = { at: Date.now(), maps };
  return maps;
}

// ── proxy ────────────────────────────────────────────────────────────────────
const SAFE_STATIC = /^(?:index\.html|settings\.json|favicon\.(?:ico|png|svg)|manifest\.json|(?:assets|lang|js|css)\/[A-Za-z0-9._\/-]{1,200})$/;
const SAFE_MAP = /^maps\/([A-Za-z0-9_-]{1,32})\/[A-Za-z0-9._\/-]{1,200}$/;
const PASS_HEADERS = ["content-type", "content-encoding", "etag", "last-modified", "content-length"];
export function mountBlueMap(app: Hono): void {
  const handler = async (c: Context) => {
    if (!(await currentSession(c))) return c.text("unauthorized", 401);
    let rel = c.req.path.replace(/^\/map\/3d\/?/, "");
    if (rel === "") rel = "index.html";
    if (rel.includes("..") || rel.includes("//")) return c.text("bad request", 400);
    if (/\/live\/players/.test(rel)) return c.text("not found", 404); // positions stay friends-only (panel rule)
    const mm = SAFE_MAP.exec(rel);
    if (!(SAFE_STATIC.test(rel) || (mm && mappedWorlds().includes(mm[1])))) return c.text("not found", 404);
    const headers: Record<string, string> = {};
    for (const h of ["accept-encoding", "if-none-match", "if-modified-since", "accept"]) { const v = c.req.header(h); if (v) headers[h] = v; }
    let r: Response;
    try {
      r = await fetch(`${upstream()}/${rel}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`, { headers, decompress: false, signal: AbortSignal.timeout(20000) } as any);
    } catch {
      return c.text("The 3D map isn't reachable right now.", 502);
    }
    const out = new Headers();
    for (const h of PASS_HEADERS) { const v = r.headers.get(h); if (v) out.set(h, v); }
    out.set("Cache-Control", rel.startsWith("maps/") || rel === "settings.json" || rel === "index.html" ? "private, max-age=30" : "private, max-age=3600");
    out.set("Vary", "Accept-Encoding");
    out.set("X-Content-Type-Options", "nosniff");
    return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: out });
  };
  app.get("/map/3d", (c) => c.redirect("/map/3d/"));
  app.get("/map/3d/*", handler);
  // POI icons for BlueMap markers: a dot in each kind's colour.
  app.get("/map/assets/poi/:file", async (c) => {
    if (!(await currentSession(c))) return c.text("unauthorized", 401);
    const k = /^([a-z]{1,16})\.svg$/.exec(c.req.param("file"))?.[1];
    const col = k ? COLORS[k] : null;
    if (!col) return c.text("not found", 404);
    const shape = k === "tower" || k === "gate" || k === "planned" ? `<rect x="3" y="3" width="18" height="18" rx="4"` : `<circle cx="12" cy="12" r="9"`;
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${shape} fill="${col}" stroke="#0a0c10" stroke-width="3"/></svg>`,
      { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" } });
  });
}
