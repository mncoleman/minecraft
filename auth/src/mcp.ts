// Claude ⇄ Minecraft: a remote MCP endpoint (Streamable HTTP, stateless JSON
// responses) at POST /mcp. Phase 1: admins only, authenticated with a personal
// bearer token minted at /admin/claude (stored as SHA-256; shown once). The
// heavy lifting — scans, batched placement, undo journals, the avatar — lives in
// the ClaudeBuild plugin inside the game container; this layer decides WHO may do
// WHAT, WHERE (build rights = owner, shared member, or the open lobby).
import type { Hono, Context } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db, type User } from "./db.ts";
import { config } from "./config.ts";
import { currentSession } from "./session.ts";
import { shell } from "./layout.ts";
import { rcon, stripColor } from "./rcon.ts";
import {
  getWorldByMv, isLobby, listWorldsOwnedBy, listWorldsSharedWith,
  listSavedLocations, saveLocation, sanitizeWorldName, LOBBY_MV,
} from "./worlds.ts";

db.run(`CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  token_hash   TEXT UNIQUE NOT NULL,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
)`);

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();
const BUILD_URL = `http://${process.env.RCON_HOST || "mc-eagler"}:${process.env.BUILD_API_PORT || 25581}`;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// The plugin generates its token into its own config.yml on the shared game-data
// mount; read it lazily (and re-read on 401, in case the plugin regenerated it).
let buildToken: string | null = null;
function readBuildToken(): string | null {
  try {
    const y = readFileSync(`${process.env.GAMEDATA_DIR || "/gamedata"}/plugins/ClaudeBuild/config.yml`, "utf8");
    const m = y.match(/^api-token:\s*['"]?([0-9a-f]{32,})['"]?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
async function plugin(path: string, body: unknown, timeoutMs = 30000): Promise<any> {
  if (!buildToken) buildToken = readBuildToken();
  if (!buildToken) throw new Error("ClaudeBuild plugin isn't installed or hasn't started yet.");
  const call = () => fetch(BUILD_URL + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + buildToken, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let r = await call();
  if (r.status === 401) { buildToken = readBuildToken(); r = await call(); }
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

// ── auth ─────────────────────────────────────────────────────────────────────
type Caller = { user: User; owner: boolean };
function callerFromBearer(c: Context): Caller | null {
  const h = c.req.header("Authorization") || "";
  const m = h.match(/^Bearer\s+(mcb_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const row = db.query("SELECT id, user_id FROM mcp_tokens WHERE token_hash = ?").get(sha256(m[1])) as { id: string; user_id: string } | null;
  if (!row) return null;
  const user = db.query("SELECT * FROM users WHERE id = ?").get(row.user_id) as User | null;
  if (!user || !user.is_admin) return null; // phase 1: admins only, re-checked every call
  db.run("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  return { user, owner: !!user.email && user.email.toLowerCase() === OWNER_EMAIL };
}

/** Build rights: the open lobby, or a registered world you own or are shared on. */
function canBuild(u: User, mv: string): boolean {
  if (isLobby(mv)) return true;
  const w = getWorldByMv(mv);
  if (!w || w.status !== "active") return false;
  if (w.owner_user_id === u.id) return true;
  return !!db.query("SELECT 1 FROM world_shares WHERE world_id = ? AND grantee_user_id = ?").get(w.id, u.id);
}
function buildableWorlds(u: User): string[] {
  return [LOBBY_MV, ...listWorldsOwnedBy(u.id).map((w) => w.mv_world_name), ...listWorldsSharedWith(u.id).map((w) => w.mv_world_name)];
}
function knownWorld(mv: string): boolean { return isLobby(mv) || !!getWorldByMv(mv); }

// run_command is an ALLOWLIST (a deny list was bypassable via namespaces like
// "minecraft:op", "execute ... op", and non-ASCII chars RCON truncates to ASCII).
// Block-editing commands are excluded on purpose: edits go through `build`, which
// enforces build rights and keeps an undo journal.
const NAME = "[A-Za-z0-9_]{1,16}";
const COORD = "~?-?\\d{0,8}(?:\\.\\d+)?";
const ALLOWED_CMDS: RegExp[] = [
  /^time (set (day|night|noon|midnight|\d{1,6})|add \d{1,6}|query (daytime|gametime|day))$/i,
  /^weather (clear|rain|thunder)( \d{1,6})?$/i,
  /^gamerule (doDaylightCycle|doWeatherCycle) (true|false)$/i,
  new RegExp(`^gamemode (survival|creative|adventure|spectator|[0-3]) ${NAME}$`, "i"),
  new RegExp(`^(tp|teleport) ${NAME} ${COORD} ${COORD} ${COORD}( -?\\d{1,3} -?\\d{1,2})?$`, "i"),
  new RegExp(`^(tp|teleport) ${NAME} ${NAME}$`, "i"),
  new RegExp(`^execute ${NAME} ~ ~ ~ locate (Village|Mansion|Mineshaft|Monument|Stronghold|Temple|EndCity|Fortress)$`, "i"),
  /^(list|seed)$/i,
  /^mv (list|who|info [A-Za-z0-9_-]{1,32})$/i,
];
function commandAllowed(cmd: string): boolean { return ALLOWED_CMDS.some((r) => r.test(cmd)); }

// ── tools ────────────────────────────────────────────────────────────────────
const vec3 = { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3, description: "[x, y, z] absolute world coordinates" };
const TOOLS = [
  {
    name: "get_status",
    description: "Where you (the signed-in player) are right now: online?, world, exact position, yaw/pitch, which way you face, game mode, the block you stand on. Also lists the worlds you may build in. Call this first.",
    inputSchema: { type: "object", properties: { player: { type: "string", description: "Optional: another online player's name to locate instead." } } },
  },
  {
    name: "list_places",
    description: "Your saved named places in a world (e.g. 'Base', 'Nearest Village'). Use these to resolve names like 'the village' or 'the castle' to coordinates.",
    inputSchema: { type: "object", properties: { world: { type: "string" } }, required: ["world"] },
  },
  {
    name: "save_place",
    description: "Save a named place in a world (shows up in the panel's Saved locations too).",
    inputSchema: { type: "object", properties: { world: { type: "string" }, name: { type: "string" }, pos: vec3 }, required: ["world", "name", "pos"] },
  },
  {
    name: "scan",
    description: "Read the world. mode='heightmap' (default for planning): ground y per column + surface block for an x/z area (max 128x128) — use it to find where the ground is before building. mode='blocks': every block in a box (max 32768 blocks) as a palette + one text grid per y layer — use it to inspect or verify a build. Grids: rows go z increasing SOUTH, chars go x increasing EAST.",
    inputSchema: { type: "object", properties: { world: { type: "string" }, mode: { type: "string", enum: ["heightmap", "blocks"] }, from: vec3, to: vec3 }, required: ["world", "mode", "from", "to"] },
  },
  {
    name: "build",
    description: [
      "Place blocks. All coordinates are ABSOLUTE (no player-relative origins). Ops are applied in order; later ops win on the same block. Up to 200,000 blocks per call; split bigger work into stages.",
      "Op types:",
      "  {type:'set', pos:[x,y,z], block}",
      "  {type:'fill', from, to, block, mode:'solid'|'shell'|'walls'|'floor_walls'}  (walls = 4 sides only; floor_walls = no roof; use block 'air' to clear)",
      "  {type:'line', from, to, block}",
      "  {type:'cylinder', center:[x,y,z] (bottom centre), radius, height, block, hollow}",
      "  {type:'sphere', center, radius, block, hollow}",
      "  {type:'blocks', origin:[x,y,z], list:[[dx,dy,dz,'block'], ...]}  (a relative blueprint)",
      "Blocks are 1.12 names with optional :data — vanilla ids ('oak_stairs:1','planks:2','golden_rail','log2:1') or Bukkit names ('wood_stairs','powered_rail'). Players use 1.8 clients, so blocks newer than 1.8 (concrete, terracotta colours, shulker boxes, observers...) render as substitutes — prefer 1.8 blocks.",
      "Data values: stairs 0=ascend toward +x(east),1=-x(west),2=+z(south),3=-z(north) (+4 = upside-down). rail/golden_rail 0=north-south, 1=east-west; ramps 2=up to east,3=up to west,4=up to north,5=up to south. torch 5=standing. Doors: lower half 0-3 facing, upper half 8.",
      "Safety: blocks holding contents (chests, signs, spawners, banners…) are never overwritten. only_air:true leaves every existing non-air block alone (great for decorating without damaging terrain).",
      "Returns a job id + counts; keep the id — `undo` reverts the whole build.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        world: { type: "string" },
        label: { type: "string", description: "Short description, e.g. 'cart line village→castle, segment 1'" },
        only_air: { type: "boolean" },
        ops: { type: "array", items: { type: "object" } },
      },
      required: ["world", "ops"],
    },
  },
  {
    name: "job_status",
    description: "Progress / result of a build or undo job (waits up to 20s if it's still running).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "undo",
    description: "Revert a build job exactly. Blocks someone changed since are left as they are.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "say",
    description: "Say something in game chat as Claude (everyone online sees it). Good for 'starting the cart line now' or asking where to put something.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "run_command",
    description: "Server owner only. Run a vanilla/Multiverse console command and get its output, e.g. 'execute <player> ~ ~ ~ locate Village' (returns x/z of the nearest village in that player's world), 'time set 1000', 'gamerule doDaylightCycle false', 'gamemode creative <player>', 'tp <player> x y z'. No leading slash. WorldEdit (//) can't run from console — use `build`. Server-admin commands (stop, op, ban, permissions, world deletion…) are refused.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

const INSTRUCTIONS = `You are building in a private Minecraft server (Paper 1.12.2; players use 1.8 browser clients) together with the signed-in player.
Axes: x increases EAST, z increases SOUTH, y is up (ground is usually y 60-80). Yaw 0 = facing south, 90 = west, 180 = north, 270 = east.
Workflow that works: (1) get_status to see where the player is and which worlds you may build in; (2) resolve named places with list_places (or run_command 'execute <player> ~ ~ ~ locate Village'); (3) scan heightmap over the area to find the real ground y — never guess; (4) build in stages with clear labels; (5) scan blocks to verify each stage, fix with another build or undo. Tell the player in chat (say) what you're doing.
Minecarts (1.12): rails need a solid block under them; max grade is 1 up per 1 across (rail data 2-5 ramps); powered rails ("golden_rail") only push when powered — put a redstone_block or redstone_torch under/next to them; one source powers up to 8 rails each way. Flat track: a powered rail every ~30 blocks keeps full speed; uphill: every 2-4 blocks. Unpowered powered rails BRAKE carts. Put a solid stop block at track ends; a station = powered rail against the stop block with a button or redstone_block. Powered rails can't curve; curves use plain rails.`;

const sayLog = new Map<string, number[]>();
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (m: string): ToolResult => ({ content: [{ type: "text", text: m }], isError: true });

function worldArg(a: any): string {
  const mv = String(a?.world ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(mv)) throw new Error("Invalid world name.");
  return mv;
}
function v3(a: any, k: string): [number, number, number] {
  const v = a?.[k];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => Number.isInteger(n))) throw new Error(`'${k}' must be [x, y, z] integers.`);
  if (Math.abs(v[0]) > 29_999_000 || Math.abs(v[2]) > 29_999_000 || v[1] < -64 || v[1] > 320) throw new Error(`'${k}' is out of world bounds.`);
  return v as [number, number, number];
}

async function callTool(caller: Caller, name: string, a: any): Promise<ToolResult> {
  const u = caller.user;
  try {
    switch (name) {
      case "get_status": {
        const target = a?.player ? String(a.player) : u.username;
        const st = await plugin("/player", { name: target });
        return ok({ player: target, ...st, you_can_build_in: buildableWorlds(u), can_run_commands: caller.owner });
      }
      case "list_places": {
        const mv = worldArg(a);
        const places = listSavedLocations(u.id, mv).map((p) => ({ name: p.name, pos: [p.x, p.y, p.z] }));
        return ok({ world: mv, places, note: places.length ? undefined : "No saved places in this world. Ask the player, use locate, or save_place." });
      }
      case "save_place": {
        const mv = worldArg(a);
        if (!knownWorld(mv)) return fail(`Unknown world '${mv}'.`);
        const name = String(a?.name ?? "").trim().slice(0, 40);
        if (!name) return fail("Name required.");
        const [x, y, z] = v3(a, "pos");
        saveLocation(u.id, name, mv, x, y, z);
        return ok(`Saved '${name}' at ${x} ${y} ${z} in ${mv}.`);
      }
      case "scan": {
        const mv = worldArg(a);
        if (!knownWorld(mv)) return fail(`Unknown world '${mv}'.`);
        return ok(await plugin("/scan", { world: mv, mode: a?.mode || "heightmap", from: v3(a, "from"), to: v3(a, "to") }));
      }
      case "build": {
        const mv = worldArg(a);
        if (!canBuild(u, mv)) return fail(`You don't have build rights in '${mv}'. You can build in: ${buildableWorlds(u).join(", ")}.`);
        if (!Array.isArray(a?.ops) || !a.ops.length) return fail("'ops' must be a non-empty array.");
        if (a.ops.length > 2000) return fail("Max 2000 ops per build call; use 'blocks' blueprints or split into stages.");
        const label = String(a?.label ?? "").slice(0, 120);
        const st = await plugin("/build", { world: mv, actor: u.username, label, ops: a.ops, only_air: !!a?.only_air, wait_ms: 20000 }, 60000);
        db.run("INSERT INTO mcp_jobs (job_id, user_id, world, label, created_at) VALUES (?,?,?,?,?)", [st.id, u.id, mv, label, now()]);
        return ok({ ...st, next: st.state === "done" ? "Verify with scan (mode blocks) over bbox, then undo(id) if it's wrong." : "Still running — check job_status." });
      }
      case "job_status": {
        const id = String(a?.id ?? "");
        if (!/^[bu]\d+$/.test(id)) return fail("Bad job id.");
        if (id.startsWith("b") && !db.query("SELECT 1 FROM mcp_jobs WHERE job_id = ? AND user_id = ?").get(id, u.id)) return fail("Not one of your jobs.");
        return ok(await plugin("/job", { id, wait_ms: 20000 }, 40000));
      }
      case "undo": {
        const id = String(a?.id ?? "");
        if (!/^b\d+$/.test(id)) return fail("Bad build job id (they start with 'b').");
        const row = db.query("SELECT world FROM mcp_jobs WHERE job_id = ? AND user_id = ?").get(id, u.id) as { world: string } | null;
        if (!row) return fail("Not one of your builds.");
        if (!canBuild(u, row.world)) return fail(`You no longer have build rights in '${row.world}'.`);
        return ok(await plugin("/undo", { id, actor: u.username, wait_ms: 20000 }, 40000));
      }
      case "say": {
        const msg = String(a?.message ?? "").trim();
        if (!msg) return fail("Empty message.");
        const t = Date.now(), recent = (sayLog.get(u.id) || []).filter((x) => t - x < 60_000);
        if (recent.length >= 10) return fail("Slow down: max 10 chat messages a minute.");
        recent.push(t); sayLog.set(u.id, recent);
        await plugin("/say", { message: msg });
        return ok("Said it.");
      }
      case "run_command": {
        if (!caller.owner) return fail("run_command is limited to the server owner.");
        const cmd = String(a?.command ?? "").replace(/^\s*\/+/, "").trim().replace(/\s+/g, " ");
        if (!cmd || cmd.length > 200 || !/^[\x20-\x7E]+$/.test(cmd)) return fail("Give one plain-ASCII command.");
        if (!commandAllowed(cmd)) return fail("Not on the allowed list. Allowed: time, weather, gamerule doDaylightCycle/doWeatherCycle, gamemode <mode> <player>, tp <player> x y z | <player>, execute <player> ~ ~ ~ locate <Structure>, list, seed, mv list/who/info. To change blocks use `build`.");
        const out = stripColor(await rcon(cmd, 10000)).trim();
        return ok(out || "(no output)");
      }
      default:
        return fail(`Unknown tool '${name}'.`);
    }
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}

db.run(`CREATE TABLE IF NOT EXISTS mcp_jobs (
  job_id     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  world      TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
)`);

// ── JSON-RPC ─────────────────────────────────────────────────────────────────
async function handleRpc(caller: Caller, msg: any): Promise<any | null> {
  const id = msg?.id;
  const isNote = id === undefined || id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof msg?.method !== "string") return isNote ? null : error(-32600, "Invalid request");
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "minecraft-mncoleman", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      return reply(await callTool(caller, name, msg.params?.arguments ?? {}));
    }
    default:
      if (isNote) return null; // notifications/initialized etc.
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

export function mountMcp(app: Hono): void {
  app.post("/mcp", async (c) => {
    const caller = callerFromBearer(c);
    if (!caller) {
      c.header("WWW-Authenticate", 'Bearer realm="minecraft.mncoleman.com", error="invalid_token"');
      return c.json({ error: "Unauthorized — create a token at /admin/claude." }, 401);
    }
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    if (Array.isArray(body)) {
      if (body.length > 10) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } }, 400);
      const out = (await Promise.all(body.map((m) => handleRpc(caller, m)))).filter((x) => x !== null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handleRpc(caller, body);
    return out === null ? c.body(null, 202) : c.json(out);
  });
  app.get("/mcp", (c) => c.body(null, 405));
  app.delete("/mcp", (c) => c.body(null, 405));

  // ── token management (admins) ──────────────────────────────────────────────
  const page = (s: { sub: string; username: string }, fresh?: string, msg?: string) => {
    const rows = db.query("SELECT id, label, created_at, last_used_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC").all(s.sub) as
      Array<{ id: string; label: string; created_at: number; last_used_at: number | null }>;
    const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");
    const url = `${config.publicBaseUrl || "https://minecraft.mncoleman.com"}/mcp`;
    const body = `
      <p class="sub"><a href="/admin">← Admin</a></p>
      <h1>Claude connector</h1>
      <p class="sub">Lets Claude build with you: read the terrain, place blocks in batches, undo, chat as Claude. Admin-only for now, and it can only build where <b>you</b> have build rights.</p>
      ${fresh ? `<div class="card"><p style="margin:0 0 .5rem"><b>Your new token — copy it now, it won't be shown again:</b></p>
        <code style="word-break:break-all;display:block;margin-bottom:.8rem">${esc(fresh)}</code>
        <p class="hint" style="margin:0 0 .3rem">Add it to Claude Code (terminal or the desktop app's Code tab):</p>
        <code style="word-break:break-all;display:block">claude mcp add --transport http minecraft ${esc(url)} --header "Authorization: Bearer ${esc(fresh)}"</code>
        <p class="hint" style="margin:.6rem 0 0">claude.ai's custom connectors need OAuth, which this doesn't support yet — use Claude Code for now.</p></div>` : ""}
      <div class="card">
        <form method="post" action="/admin/claude/token" class="row" style="margin:0">
          <input name="label" placeholder="label, e.g. macbook" maxlength="40" required/>
          <button class="btn-primary">Create token</button>
        </form>
      </div>
      <h2>Your tokens</h2>
      ${rows.length ? rows.map((r) => `<div class="world"><div class="row" style="justify-content:space-between;margin:0">
        <span><b>${esc(r.label)}</b> <span class="hint">created ${when(r.created_at)} · last used ${when(r.last_used_at)}</span></span>
        <form method="post" action="/admin/claude/token/${r.id}/revoke" style="margin:0"><button class="btn-danger">Revoke</button></form>
      </div></div>`).join("") : '<p class="hint">No tokens yet.</p>'}`;
    return shell({ title: "Claude connector", active: "admin", username: s.username, admin: true, body, msg });
  };
  const adminSession = async (c: Context) => {
    if (c.req.method === "POST") {
      const site = c.req.header("Sec-Fetch-Site");
      const origin = c.req.header("Origin");
      if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== config.publicBaseUrl)) return null;
    }
    const s = await currentSession(c); return s?.admin ? s : null;
  };

  app.get("/admin/claude", async (c) => {
    const s = await adminSession(c); if (!s) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    return c.html(page(s, undefined, c.req.query("msg")));
  });
  app.post("/admin/claude/token", async (c) => {
    const s = await adminSession(c); if (!s) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const form = await c.req.parseBody();
    const label = String(form.label ?? "").trim().slice(0, 40) || "token";
    const n = (db.query("SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ?").get(s.sub) as { n: number }).n;
    if (n >= 10) return c.redirect("/admin/claude?msg=" + encodeURIComponent("You have 10 tokens; revoke one first."));
    const raw = "mcb_" + randomBytes(24).toString("base64url");
    db.run("INSERT INTO mcp_tokens (id, user_id, token_hash, label, created_at) VALUES (?,?,?,?,?)", [randomUUID(), s.sub, sha256(raw), label, now()]);
    c.header("Cache-Control", "no-store");
    return c.html(page(s, raw));
  });
  app.post("/admin/claude/token/:id/revoke", async (c) => {
    const s = await adminSession(c); if (!s) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    db.run("DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?", [c.req.param("id"), s.sub]);
    return c.redirect("/admin/claude?msg=" + encodeURIComponent("Token revoked."));
  });
}
