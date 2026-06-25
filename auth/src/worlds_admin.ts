import type { Hono, Context } from "hono";
import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { currentSession } from "./session.ts";
import { db, type User } from "./db.ts";
import {
  type World, type WorldNote,
  listAllWorlds, listWorldsOwnedBy, listWorldsSharedWith, sharesForWorld,
  getWorld, getWorldByMv, insertWorld, sanitizeWorldName,
  provisionWorld, shareWorld, unshareWorld, teleportTo, setPendingDestination,
  getNote, saveNote, getLocation, fetchWorldSeed, readMvWorld,
  recordTeleport, recentTeleports, listSavedLocations, saveLocation, updateSavedLocation, deleteSavedLocation,
} from "./worlds.ts";
import { getPresence, type OnlinePlayer } from "./presence.ts";
import { ownedWorldCount } from "./db.ts";
import { visibleOnlineUsernames, listFriends, areFriends } from "./friends.ts";

function canAccess(w: World, m: { sub: string; admin: boolean }): boolean {
  if (w.owner_user_id === m.sub || m.admin) return true;
  return !!db.query("SELECT 1 FROM world_shares WHERE world_id=? AND grantee_user_id=?").get(w.id, m.sub);
}
import { rcon, stripColor } from "./rcon.ts";
import { config } from "./config.ts";
import { shell } from "./layout.ts";

const GLOBAL_WORLD_CAP = Number(process.env.WORLD_CAP || 8);
// How many worlds a non-admin may own. Admins are bound only by the global cap.
const PER_USER_WORLD_CAP = Number(process.env.PER_USER_WORLD_CAP || 3);
const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function userById(id: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}
function userByUsername(name: string): User | null {
  return db.query("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(name) as User | null;
}
// Chunkbase seed map, pre-set to Java 1.12 (the version we run). The seed is
// what makes the map correct; the user just confirms the version dropdown.
function mapUrl(seed: string): string {
  return `https://www.chunkbase.com/apps/seed-map#seed=${encodeURIComponent(seed)}&platform=java_1_12&dimension=overworld`;
}

// ── page ─────────────────────────────────────────────────────────────────────
function worldsPage(me: { sub: string; username: string; admin: boolean; owner: boolean }, onlineAll: OnlinePlayer[], msg?: string, err?: string): string {
  const owned = listWorldsOwnedBy(me.sub);
  const shared = listWorldsSharedWith(me.sub);
  // Privacy: non-admins only see friends, world co-members, and themselves online.
  const visible = me.admin ? null : visibleOnlineUsernames(me.sub);
  const online = visible ? onlineAll.filter((p) => visible.has(p.name.toLowerCase())) : onlineAll;
  const atUserCap = !me.admin && ownedWorldCount(me.sub) >= PER_USER_WORLD_CAP;

  const memberRows = (w: World) =>
    sharesForWorld(w.id).map((m) =>
      `<tr><td>${esc(m.username)}</td><td style="text-align:right"><form method="post" action="/worlds/${w.id}/unshare" style="margin:0"><input type="hidden" name="grantee" value="${m.grantee_user_id}"/><button class="btn-danger">revoke</button></form></td></tr>`,
    ).join("") || `<tr><td colspan="2" class="hint">no one yet — grant someone above</td></tr>`;

  const cardLinks = (w: World) =>
    `<span class="row" style="margin:0;gap:.4rem">
      ${w.seed ? `<code class="hint" style="font-size:.74rem" title="World seed (Java 1.12.2) — select to copy">${esc(w.seed)}</code>` : ""}
      <a class="pill" href="/worlds/${w.id}/notes">📝 Notes</a>
      <a class="pill" href="/worlds/${w.id}/console">🎮 Command</a>
      ${w.seed ? `<a class="pill" href="${mapUrl(w.seed)}" target="_blank" rel="noopener" title="Open the Chunkbase seed map — set the version to Java 1.12">🗺 Map</a>` : ""}
      <form method="post" action="/worlds/${w.id}/hop" style="margin:0"><button class="btn-ghost">Hop in →</button></form>
    </span>`;

  // Candidates the viewer may grant build access to for this world: admins/owner
  // see all users; regular users see only their friends. Always excludes the
  // owner and anyone already shared with.
  const shareCandidates = (w: World): Array<{ id: string; username: string }> => {
    const sharedIds = new Set(sharesForWorld(w.id).map((s) => s.grantee_user_id));
    const pool = me.admin
      ? (db.query("SELECT id, username FROM users ORDER BY username COLLATE NOCASE").all() as Array<{ id: string; username: string }>)
      : listFriends(me.sub).map((f) => ({ id: f.id, username: f.username }));
    return pool.filter((u) => u.id !== w.owner_user_id && !sharedIds.has(u.id));
  };

  const shareForm = (w: World) => {
    const cands = shareCandidates(w);
    if (!cands.length) {
      return `<p class="hint" style="margin:.5rem 0 0">${me.admin
        ? "No other users to grant access to yet."
        : 'Add friends on the <a href="/friends">Friends</a> tab to share this world with them.'}</p>`;
    }
    return `<form method="post" action="/worlds/${w.id}/share" class="row">
      <select name="username" required>${cands.map((u) => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join("")}</select>
      <button class="btn-primary">Grant build access</button>
    </form>`;
  };

  const ownedBlock = (w: World) => `<div class="world">
    <div class="row" style="justify-content:space-between;margin-top:0">
      <span><b>${esc(w.name)}</b> <code>${esc(w.mv_world_name)}</code></span>
      ${cardLinks(w)}
    </div>
    ${shareForm(w)}
    <table>${memberRows(w)}</table>
  </div>`;

  const sharedBlock = (w: World & { owner_username: string }) => `<div class="world"><div class="row" style="justify-content:space-between;margin:0">
      <span><b>${esc(w.name)}</b> <code>${esc(w.mv_world_name)}</code> <span class="hint">— shared by ${esc(w.owner_username)}</span></span>
      ${cardLinks(w)}</div></div>`;

  // One online player → a row with a "Join →" button when the caller can build
  // in that player's current world (registered + shared/owned/admin, or the open
  // lobby which isn't a registered world). Clicking it teleports you to them.
  const onlineRow = (p: OnlinePlayer) => {
    const isSelf = p.name.toLowerCase() === me.username.toLowerCase();
    const target = getWorldByMv(p.world);
    const joinable = !isSelf && (!target || canAccess(target, me));
    const right = isSelf
      ? '<span class="hint">that\'s you</span>'
      : joinable
        ? `<form method="post" action="/worlds/hop-to" style="margin:0"><input type="hidden" name="mv" value="${esc(p.world)}"/><button class="btn-ghost">Join →</button></form>`
        : '<span class="hint">no access</span>';
    return `<div class="row" style="justify-content:space-between;margin:.3rem 0"><span><span class="dot on"></span><b>${esc(p.name)}</b> <span class="hint">in ${esc(p.world)}</span></span>${right}</div>`;
  };

  const body = `
    <h1>Worlds</h1>
    <p class="sub">Having access to a world means you can build in it. Hit <b>Play</b> first (it connects you to the server), then use <b>Hop in</b> or <b>Join →</b> to teleport.</p>

    <div class="card">
      <p style="margin:.1rem 0 .6rem"><b>What's a world?</b> A world is a Minecraft map. When you first hit <b>Play</b> you land in the shared <b>lobby</b> — a common area anyone can visit. It saves, but it belongs to everyone.</p>
      <p style="margin:0"><b>Want your own space?</b> Create a world below. It's yours, your builds there save automatically, and only you (plus anyone you grant access) can build in it.</p>
    </div>

    <h2>Who's online</h2>
    ${online.length
      ? `<div class="card">${online.map(onlineRow).join("")}</div>`
      : me.admin
        ? '<p class="hint">No one is online right now. Hit <b>Play</b> to jump on.</p>'
        : '<p class="hint">None of your friends are online right now. You only see friends and people you share a world with here — add friends in the <a href="/friends">Friends</a> tab.</p>'}

    <h2>My worlds</h2>
    ${owned.length ? owned.map(ownedBlock).join("") : '<p class="hint">You don\'t own any worlds yet — create one below.</p>'}

    <h2>Shared with me</h2>
    ${shared.length ? shared.map(sharedBlock).join("") : '<p class="hint">Nothing shared with you yet.</p>'}

    <h2>Create a world</h2>
    <div class="card">
      <p class="hint" style="margin:.1rem 0 .7rem">Pick a short name (letters, numbers and dashes). You'll become its owner, and you can share build access with friends from your world card above.</p>
      ${atUserCap
        ? `<p class="hint" style="margin:0">You've reached your limit of ${PER_USER_WORLD_CAP} worlds. Ask an admin if you need more.</p>`
        : `<form method="post" action="/worlds/create" class="row" style="margin:0" onsubmit="var b=this.querySelector('button');if(b.disabled)return false;b.disabled=true;b.textContent='Creating…'"><input name="name" placeholder="my world name" required/><button class="btn-primary">Create</button></form>
           ${me.admin ? "" : `<p class="hint" style="margin:.6rem 0 0">You can create up to ${PER_USER_WORLD_CAP} worlds.</p>`}`}
      ${me.admin ? `
      <div style="margin-top:.9rem;padding-top:.9rem;border-top:1px solid #232a35">
        <div class="hint" style="margin-bottom:.4rem">Admin tools</div>
        ${me.owner ? `<form method="post" action="/worlds/upload" enctype="multipart/form-data" class="row"><input type="file" name="world" accept=".zip" required/><input name="name" placeholder="world name"/><button class="btn-ghost">Upload .zip</button></form>` : ""}
        <form method="post" action="/worlds/register" class="row"><input name="mv" placeholder="existing world folder (e.g. cliffbuild)" required/><input name="name" placeholder="display name"/><button class="btn-ghost">Register existing</button></form>
        <p class="hint" style="margin:.6rem 0 0">Upload a vanilla world .zip (overworld), or manage users &amp; invites in the <a href="/admin">Admin</a> tab.</p>
      </div>` : ""}
    </div>
  `;
  return shell({ title: "Worlds", active: "worlds", username: me.username, admin: me.admin, body, msg, err });
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function me(c: Context) {
  const s = await currentSession(c);
  if (!s) return null;
  const u = db.query("SELECT email FROM users WHERE id = ?").get(s.sub) as { email: string | null } | null;
  const owner = !!u?.email && u.email.toLowerCase() === OWNER_EMAIL;
  return { sub: s.sub, username: s.username, admin: !!s.admin, owner };
}
function redirect(c: Context, q = ""): Response {
  return c.redirect("/worlds" + q);
}

// ── command-center input validation (every value reaching RCON passes here) ───
function intArg(v: unknown, min = -30_000_000, max = 30_000_000): string {
  const n = Number(String(v ?? "").trim());
  if (!Number.isInteger(n)) throw new Error("Must be a whole number.");
  if (n < min || n > max) throw new Error(`Number must be between ${min} and ${max}.`);
  return String(n);
}
function pickEnum(v: unknown, allowed: string[]): string {
  const s = String(v ?? "");
  if (!allowed.includes(s)) throw new Error("Invalid option.");
  return s;
}
function itemArg(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]+(:[a-z0-9_]+)?$/.test(s) || s.length > 50) throw new Error("Invalid item id.");
  return s;
}
function worldMembers(w: World): Array<{ username: string; isOwner: boolean }> {
  const out: Array<{ username: string; isOwner: boolean }> = [];
  const o = userById(w.owner_user_id);
  if (o) out.push({ username: o.username, isOwner: true });
  for (const s of sharesForWorld(w.id)) out.push({ username: s.username, isOwner: false });
  return out;
}
function playerArg(v: unknown, w: World): string {
  const s = String(v ?? "").trim().toLowerCase();
  const match = worldMembers(w).find((m) => m.username.toLowerCase() === s);
  if (!match) throw new Error("Unknown player for this world.");
  return match.username; // canonical, already charset-safe from signup
}

// ── Notes page ───────────────────────────────────────────────────────────────
function notesPage(w: World, meCtx: { username: string; admin: boolean }, note: WorldNote | null, msg?: string, err?: string): string {
  const editor = note?.updated_by ? userById(note.updated_by)?.username : null;
  const when = note?.updated_at ? new Date(note.updated_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;
  const body = `
    <p class="sub"><a href="/worlds">← Worlds</a></p>
    <h1>📝 Notes — ${esc(w.name)}</h1>
    <p class="sub">Shared notepad for this world — everyone with access can read &amp; edit. ${when ? `Last saved ${when}${editor ? " by " + esc(editor) : ""}.` : "No notes yet."}</p>
    <div class="card">
      <form method="post" action="/worlds/${w.id}/notes">
        <textarea name="body" placeholder="Build plans, coordinates, to-dos…">${esc(note?.body || "")}</textarea>
        <button class="btn-primary" style="margin-top:.6rem">Save notes</button>
      </form>
    </div>`;
  return shell({ title: "Notes", active: "worlds", username: meCtx.username, admin: meCtx.admin, body, msg, err });
}

// ── Command Center page ──────────────────────────────────────────────────────
function consolePage(w: World, meCtx: { sub: string; username: string; admin: boolean; owner: boolean }, online: OnlinePlayer[], msg?: string, err?: string): string {
  const byName = new Map(online.map((p) => [p.name.toLowerCase(), p]));
  const meOn = byName.get(meCtx.username.toLowerCase());
  const inWorld = !!meOn && meOn.world === w.mv_world_name;
  const meHere = !!(inWorld && meOn && typeof meOn.x === "number");
  const recent = recentTeleports(meCtx.sub, w.mv_world_name); // per-world only
  const saved = listSavedLocations(meCtx.sub, w.mv_world_name); // per-world only
  const curDiff = (readMvWorld(w.mv_world_name).difficulty || "").toLowerCase(); // live, from MV worlds.yml

  const status = !meOn
    ? `<span class="badge" style="background:#5a2230;color:#ffb3c0">offline — hit Play to run commands</span>`
    : inWorld
      ? `<span class="badge badge-ok">in this world${typeof meOn.x === "number" ? ` @ ${meOn.x}, ${meOn.y}, ${meOn.z}` : ""}</span>`
      : `<span class="badge" style="background:#5a4a22;color:#ffe0a3">online in ${esc(meOn.world)} — coord/time/weather need you inside ${esc(w.mv_world_name)}</span>`;

  const playerOpts = worldMembers(w).map((mem) => {
    const on = byName.get(mem.username.toLowerCase());
    const live = on && typeof on.x === "number" ? { world: on.world, x: on.x, y: on.y as number, z: on.z as number } : null;
    const loc = live || getLocation(mem.username);
    const label = on
      ? (live ? `${mem.username} · online · ${live.world} (${live.x}, ${live.y}, ${live.z})` : `${mem.username} · online`)
      : loc ? `${mem.username} · last seen · ${loc.world} (${loc.x}, ${loc.y}, ${loc.z})`
      : `${mem.username} · never seen`;
    return `<option value="${esc(mem.username)}"${!on && !loc ? " disabled" : ""}>${esc(label)}</option>`;
  }).join("");

  const card = (title: string, inner: string, note?: string) => `
    <div class="card">
      <div style="font-weight:600;margin-bottom:.5rem">${title}</div>
      <form method="post" action="/worlds/${w.id}/run" class="row" style="align-items:flex-end;margin:0">${inner}<button class="btn-primary">Run</button></form>
      ${note ? `<p class="hint" style="margin:.45rem 0 0">${note}</p>` : ""}
    </div>`;

  // hidden world+x+y+z+label fields for a "go to this exact spot" tp_loc form
  const locFields = (world: string, x: number, y: number, z: number, label: string) =>
    `<input type="hidden" name="cmd" value="tp_loc"><input type="hidden" name="world" value="${esc(world)}"><input type="hidden" name="x" value="${x}"><input type="hidden" name="y" value="${y}"><input type="hidden" name="z" value="${z}"><input type="hidden" name="label" value="${esc(label)}">`;

  const recentBlock = `
    <div class="card">
      <div style="font-weight:600;margin-bottom:.5rem">Recently teleported <span class="hint" style="font-weight:400">· ${esc(w.name)}</span></div>
      ${recent.length ? recent.map((r) => `
        <div class="row" style="justify-content:space-between;margin:.3rem 0">
          <span>${r.label ? "<b>" + esc(r.label) + "</b> " : ""}<span class="hint">${esc(r.world)} (${r.x}, ${r.y}, ${r.z})</span></span>
          <form method="post" action="/worlds/${w.id}/run" style="margin:0">${locFields(r.world, r.x, r.y, r.z, r.label || "")}<button class="btn-ghost">Go again →</button></form>
        </div>`).join("") : '<p class="hint">No teleports yet — use the controls above.</p>'}
    </div>`;

  const savedRow = (s: { id: string; world: string; x: number; y: number; z: number; name: string }) => `
    <div class="world" style="padding:.55rem .75rem">
      <form method="post" action="/worlds/${w.id}/saveloc/${s.id}" class="row" style="margin:0">
        <input name="name" value="${esc(s.name)}" required style="flex:1;min-width:110px">
        <input type="hidden" name="world" value="${esc(s.world)}">
        <span>X<input name="x" type="number" value="${s.x}" style="width:72px"></span>
        <span>Y<input name="y" type="number" value="${s.y}" style="width:72px"></span>
        <span>Z<input name="z" type="number" value="${s.z}" style="width:72px"></span>
        <span class="hint">${esc(s.world)}</span>
        <button class="btn-ghost" type="submit">Update</button>
      </form>
      <div class="row" style="margin:.4rem 0 0;gap:.4rem">
        <form method="post" action="/worlds/${w.id}/run" style="margin:0">${locFields(s.world, s.x, s.y, s.z, s.name)}<button class="btn-primary">Go →</button></form>
        <form method="post" action="/worlds/${w.id}/saveloc/${s.id}/delete" style="margin:0"><button class="btn-danger">Delete</button></form>
      </div>
    </div>`;

  const savedBlock = `
    <div class="card">
      <div style="font-weight:600;margin-bottom:.5rem">Saved locations <span class="hint" style="font-weight:400">· ${esc(w.name)}</span></div>
      <form method="post" action="/worlds/${w.id}/saveloc" class="row" style="margin:0 0 .6rem">
        <input name="name" placeholder="name (e.g. base, farm)" required style="flex:1;min-width:130px">
        <span>X<input name="x" type="number" ${meHere ? `value="${meOn!.x}"` : ""} required style="width:74px"></span>
        <span>Y<input name="y" type="number" ${meHere ? `value="${meOn!.y}"` : ""} required style="width:74px"></span>
        <span>Z<input name="z" type="number" ${meHere ? `value="${meOn!.z}"` : ""} required style="width:74px"></span>
        <button class="btn-primary">Save</button>
      </form>
      ${meHere ? '<p class="hint" style="margin:0 0 .6rem">Coords are prefilled with your current spot — just name it and Save.</p>' : '<p class="hint" style="margin:0 0 .6rem">Enter coordinates to save (or join the world to auto-fill your current spot).</p>'}
      ${saved.length ? saved.map(savedRow).join("") : '<p class="hint">No saved locations yet.</p>'}
    </div>`;

  const body = `
    <p class="sub"><a href="/worlds">← Worlds</a></p>
    <h1>🎮 Command Center — ${esc(w.name)} <code>${esc(w.mv_world_name)}</code></h1>
    <p class="sub">Run commands in this world. ${status}</p>

    ${card("Teleport to coordinates", `<input type="hidden" name="cmd" value="tp_coords"/>
      <span>X<br><input name="x" type="number" required style="width:90px"></span>
      <span>Y<br><input name="y" type="number" required style="width:90px"></span>
      <span>Z<br><input name="z" type="number" required style="width:90px"></span>`,
      "Teleports you to these coordinates in this world.")}

    ${card("Teleport to a player", `<input type="hidden" name="cmd" value="tp_player"/>
      <select name="target" style="flex:1;min-width:240px">${playerOpts || '<option disabled>no members</option>'}</select>`,
      "Jumps you to them — live if they're online, otherwise their last-known spot.")}

    ${recentBlock}

    ${savedBlock}

    ${card("Game mode (you)", `<input type="hidden" name="cmd" value="gamemode"/>
      <select name="mode"><option value="creative">creative</option><option value="survival">survival</option><option value="adventure">adventure</option><option value="spectator">spectator</option></select>`)}

    ${card("Difficulty (this world)", `<input type="hidden" name="cmd" value="difficulty"/>
      <select name="val">${["peaceful", "easy", "normal", "hard"].map((d) => `<option${d === curDiff ? " selected" : ""}>${d}</option>`).join("")}</select>`,
      `Currently <b>${esc(curDiff || "unknown")}</b>. Persists for this world (applies even when nobody's in it).`)}

    ${card("Set time", `<input type="hidden" name="cmd" value="time"/>
      <select name="val"><option>day</option><option>noon</option><option>night</option><option>midnight</option></select>`)}

    ${card("Set weather", `<input type="hidden" name="cmd" value="weather"/>
      <select name="val"><option>clear</option><option>rain</option><option>thunder</option></select>`)}

    ${card("Give item (to you)", `<input type="hidden" name="cmd" value="give"/>
      <input name="item" placeholder="item id, e.g. diamond_pickaxe" required style="flex:1;min-width:200px">
      <span>×<input name="count" type="number" value="1" min="1" max="64" style="width:72px"></span>`,
      "Names like <code>diamond</code>, <code>oak_log</code>, <code>diamond_sword</code> (1.12.2 ids).")}

    ${meCtx.owner ? card("Raw command (owner)", `<input type="hidden" name="cmd" value="raw"/>
      <input name="raw" placeholder="command without the slash, e.g. difficulty peaceful" required style="flex:1;min-width:260px">`,
      "⚠️ Runs verbatim on the server console — full power, owner-only.") : ""}
  `;
  return shell({ title: "Command Center", active: "worlds", username: meCtx.username, admin: meCtx.admin, body, msg, err });
}

export function mountWorlds(app: Hono): void {
  app.get("/worlds", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const online = await getPresence();
    return c.html(worldsPage(m, online, c.req.query("msg"), c.req.query("err")));
  });

  // Create a brand-new world (admin). Caller becomes owner.
  app.post("/worlds/create", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    // Anyone may create a world. Non-admins are bound by a per-user cap; everyone
    // is bound by the global cap (which protects server disk).
    if (!m.admin && ownedWorldCount(m.sub) >= PER_USER_WORLD_CAP) {
      return redirect(c, "?err=" + encodeURIComponent(`You've reached your limit of ${PER_USER_WORLD_CAP} worlds.`));
    }
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim();
    const mv = sanitizeWorldName(name);
    if (mv.length < 1) return redirect(c, "?err=" + encodeURIComponent("Invalid world name."));
    if (getWorldByMv(mv)) return redirect(c, "?err=" + encodeURIComponent("A world with that name already exists."));
    if (listAllWorlds().length >= GLOBAL_WORLD_CAP) return redirect(c, "?err=" + encodeURIComponent(`The server is at its world limit (${GLOBAL_WORLD_CAP}). Ask an admin.`));
    try {
      const out = stripColor(await rcon(`mv create ${mv} normal`));
      if (!/complete|already/i.test(out)) {
        // mv create echoes "Complete!"; if not, surface it
      }
      await provisionWorld(mv, m.username);
      insertWorld({ id: randomUUID(), name: name || mv, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv), source: "created", status: "active" });
      return redirect(c, "?msg=" + encodeURIComponent(`World '${mv}' created.`));
    } catch (e: any) {
      const msg = e?.message || String(e);
      // A UNIQUE violation here almost always means the Create button was
      // double-submitted: the first request already made the world, and the
      // second raced past the getWorldByMv check before that insert committed.
      // The world the user asked for exists, so report success, not an error.
      if (/UNIQUE constraint/i.test(msg)) {
        return redirect(c, "?msg=" + encodeURIComponent(`World '${mv}' is ready.`));
      }
      return redirect(c, "?err=" + encodeURIComponent("Create failed: " + msg));
    }
  });

  // Register an already-existing Multiverse world (e.g. cliffbuild) into the DB + provision it.
  app.post("/worlds/register", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    if (!m.admin) return redirect(c, "?err=" + encodeURIComponent("Only admins can register worlds."));
    const form = await c.req.parseBody();
    const mv = sanitizeWorldName(String(form.mv ?? ""));
    const name = String(form.name ?? "").trim() || mv;
    if (!mv) return redirect(c, "?err=" + encodeURIComponent("Invalid world name."));
    if (getWorldByMv(mv)) return redirect(c, "?err=" + encodeURIComponent("Already registered."));
    try {
      await provisionWorld(mv, m.username);
      insertWorld({ id: randomUUID(), name, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv), source: "import", status: "active" });
      return redirect(c, "?msg=" + encodeURIComponent(`World '${mv}' registered and locked to you as owner.`));
    } catch (e: any) {
      return redirect(c, "?err=" + encodeURIComponent("Register failed: " + (e?.message || e)));
    }
  });

  // Share (grant build) with an existing user.
  app.post("/worlds/:id/share", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (w.owner_user_id !== m.sub && !m.admin) return redirect(c, "?err=" + encodeURIComponent("You can only share worlds you own."));
    const form = await c.req.parseBody();
    const grantee = userByUsername(String(form.username ?? "").trim());
    if (!grantee) return redirect(c, "?err=" + encodeURIComponent("No such user (they must already be in the system)."));
    if (grantee.id === w.owner_user_id) return redirect(c, "?msg=" + encodeURIComponent("Owner already has access."));
    // Never trust the dropdown alone: a non-admin may only grant to their friends.
    if (!m.admin && !areFriends(m.sub, grantee.id)) {
      return redirect(c, "?err=" + encodeURIComponent("You can only share with your friends. Add them on the Friends tab first."));
    }
    try {
      await shareWorld(w, grantee, m.sub);
      return redirect(c, "?msg=" + encodeURIComponent(`Granted ${grantee.username} build access to ${w.mv_world_name}.`));
    } catch (e: any) {
      return redirect(c, "?err=" + encodeURIComponent("Grant failed: " + (e?.message || e)));
    }
  });

  // Unshare (revoke).
  app.post("/worlds/:id/unshare", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (w.owner_user_id !== m.sub && !m.admin) return redirect(c, "?err=" + encodeURIComponent("You can only manage worlds you own."));
    const form = await c.req.parseBody();
    const grantee = userById(String(form.grantee ?? ""));
    if (!grantee) return redirect(c, "?err=" + encodeURIComponent("User not found."));
    try {
      await unshareWorld(w, grantee);
      return redirect(c, "?msg=" + encodeURIComponent(`Revoked ${grantee.username}.`));
    } catch (e: any) {
      return redirect(c, "?err=" + encodeURIComponent("Revoke failed: " + (e?.message || e)));
    }
  });

  // One-click hop: teleport the caller into a world they can access (must be online in-game).
  app.post("/worlds/:id/hop", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    try {
      const resp = stripColor(await teleportTo(m.username, w.mv_world_name));
      if (/cannot be found|not online|no player|couldn't be found/i.test(resp)) {
        // Offline: queue it — they'll be auto-routed when they join.
        setPendingDestination(m.username, w.mv_world_name);
        return redirect(c, "?msg=" + encodeURIComponent(`Queued — open the game (Play) and you'll drop into ${w.mv_world_name} automatically.`));
      }
      return redirect(c, "?msg=" + encodeURIComponent(`Sent you to ${w.mv_world_name} — switch to your game tab.`));
    } catch (e: any) {
      return redirect(c, "?err=" + encodeURIComponent("Hop failed: " + (e?.message || e)));
    }
  });

  // "Join →": hop to another online player's current world by Multiverse name.
  // Same access rule as /hop (registered world must be shared/owned/admin; the
  // unregistered lobby is open). If you're not in-game yet, it queues + auto-routes.
  app.post("/worlds/hop-to", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const form = await c.req.parseBody();
    const mv = sanitizeWorldName(String(form.mv ?? ""));
    if (!mv) return redirect(c, "?err=" + encodeURIComponent("No destination."));
    const w = getWorldByMv(mv);
    if (w && !canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    try {
      const resp = stripColor(await teleportTo(m.username, mv));
      if (/cannot be found|not online|no player|couldn't be found/i.test(resp)) {
        setPendingDestination(m.username, mv);
        return redirect(c, "?msg=" + encodeURIComponent(`Queued — hit Play and you'll drop into ${mv} automatically.`));
      }
      return redirect(c, "?msg=" + encodeURIComponent(`Joining ${mv} — switch to your game tab.`));
    } catch (e: any) {
      return redirect(c, "?err=" + encodeURIComponent("Join failed: " + (e?.message || e)));
    }
  });

  // ── Notes (shared per-world; anyone with access can read/edit) ──
  app.get("/worlds/:id/notes", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    return c.html(notesPage(w, m, getNote(w.id), c.req.query("msg"), c.req.query("err")));
  });
  app.post("/worlds/:id/notes", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    const form = await c.req.parseBody();
    saveNote(w.id, String(form.body ?? "").slice(0, 20000), m.sub);
    return c.redirect(`/worlds/${w.id}/notes?msg=` + encodeURIComponent("Notes saved."));
  });

  // ── Command Center (anyone with access; raw command is owner-only) ──
  app.get("/worlds/:id/console", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    return c.html(consolePage(w, m, await getPresence(), c.req.query("msg"), c.req.query("err")));
  });
  app.post("/worlds/:id/run", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    const back = (q: string) => c.redirect(`/worlds/${w.id}/console?${q}`);
    const form = await c.req.parseBody();
    const cmd = String(form.cmd ?? "");

    // Raw passthrough — owner only (equivalent to being op in-game).
    if (cmd === "raw") {
      if (!m.owner) return back("err=" + encodeURIComponent("Raw command is owner-only."));
      const raw = String(form.raw ?? "").trim().replace(/^\//, "");
      if (!raw) return back("err=" + encodeURIComponent("Empty command."));
      try { const out = stripColor(await rcon(raw)); return back("msg=" + encodeURIComponent(out.trim() || ("Ran: " + raw))); }
      catch (e: any) { return back("err=" + encodeURIComponent("Failed: " + (e?.message || e))); }
    }

    // Everything else acts on YOU and needs you in-game.
    const online = await getPresence();
    const meOn = online.find((p) => p.name.toLowerCase() === m.username.toLowerCase());
    if (!meOn) return back("err=" + encodeURIComponent("You must be in the game to run commands — hit Play first."));
    const inWorld = meOn.world === w.mv_world_name;

    let command = "";
    let dest: { world: string; x: number; y: number; z: number; label: string } | null = null;
    try {
      switch (cmd) {
        case "tp_coords": {
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first (you're in ${meOn.world}).`));
          const x = intArg(form.x), y = intArg(form.y), z = intArg(form.z);
          command = `tp ${m.username} ${x} ${y} ${z}`;
          dest = { world: meOn.world, x: +x, y: +y, z: +z, label: "" };
          break;
        }
        case "tp_player": {
          const target = playerArg(form.target, w);
          const tOn = online.find((p) => p.name.toLowerCase() === target.toLowerCase());
          if (tOn) {
            command = `tp ${m.username} ${target}`;
            if (typeof tOn.x === "number") dest = { world: tOn.world, x: tOn.x, y: tOn.y as number, z: tOn.z as number, label: "→ " + target };
          } else {
            const loc = getLocation(target);
            if (!loc) return back("err=" + encodeURIComponent(`No known location for ${target} yet.`));
            if (loc.world !== meOn.world) await teleportTo(m.username, loc.world);
            command = `tp ${m.username} ${loc.x} ${loc.y} ${loc.z}`;
            dest = { world: loc.world, x: loc.x, y: loc.y, z: loc.z, label: "→ " + target };
          }
          break;
        }
        case "tp_loc": {
          const world = sanitizeWorldName(String(form.world ?? ""));
          if (!world) return back("err=" + encodeURIComponent("Bad destination."));
          const x = intArg(form.x), y = intArg(form.y), z = intArg(form.z);
          if (meOn.world !== world) await teleportTo(m.username, world);
          command = `tp ${m.username} ${x} ${y} ${z}`;
          dest = { world, x: +x, y: +y, z: +z, label: String(form.label ?? "").slice(0, 40) };
          break;
        }
        case "gamemode":
          command = `gamemode ${pickEnum(form.mode, ["survival", "creative", "adventure", "spectator"])} ${m.username}`;
          break;
        case "difficulty":
          command = `mvm set diff ${pickEnum(form.val, ["peaceful", "easy", "normal", "hard"])} ${w.mv_world_name}`;
          break;
        case "time":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = `execute ${m.username} ~ ~ ~ time set ${pickEnum(form.val, ["day", "noon", "night", "midnight"])}`;
          break;
        case "weather":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = `execute ${m.username} ~ ~ ~ weather ${pickEnum(form.val, ["clear", "rain", "thunder"])}`;
          break;
        case "give":
          command = `give ${m.username} ${itemArg(form.item)} ${intArg(form.count, 1, 64)}`;
          break;
        default:
          return back("err=" + encodeURIComponent("Unknown command."));
      }
    } catch (e: any) {
      return back("err=" + encodeURIComponent(e?.message || "Invalid input."));
    }
    try {
      const out = stripColor(await rcon(command));
      if (dest) recordTeleport(m.sub, dest.world, dest.x, dest.y, dest.z, dest.label);
      return back("msg=" + encodeURIComponent(out.trim() || ("Ran: " + command)));
    } catch (e: any) {
      return back("err=" + encodeURIComponent("Command failed: " + (e?.message || e)));
    }
  });

  // ── Saved locations (per-user; created/edited from a world's command center) ──
  app.post("/worlds/:id/saveloc", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    const back = `/worlds/${w.id}/console`;
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().slice(0, 40);
    if (!name) return c.redirect(`${back}?err=` + encodeURIComponent("Give the location a name."));
    if (listSavedLocations(m.sub, w.mv_world_name).length >= 50) return c.redirect(`${back}?err=` + encodeURIComponent("You've hit the 50 saved-locations limit for this world."));
    try {
      saveLocation(m.sub, name, w.mv_world_name, +intArg(form.x), +intArg(form.y), +intArg(form.z));
      return c.redirect(`${back}?msg=` + encodeURIComponent(`Saved "${name}".`));
    } catch (e: any) {
      return c.redirect(`${back}?err=` + encodeURIComponent(e?.message || "Invalid coordinates."));
    }
  });
  app.post("/worlds/:id/saveloc/:locId/delete", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    deleteSavedLocation(m.sub, c.req.param("locId"));
    return c.redirect(`/worlds/${w.id}/console?msg=` + encodeURIComponent("Deleted."));
  });
  app.post("/worlds/:id/saveloc/:locId", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    const back = `/worlds/${w.id}/console`;
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().slice(0, 40);
    const world = sanitizeWorldName(String(form.world ?? "")) || w.mv_world_name;
    if (!name) return c.redirect(`${back}?err=` + encodeURIComponent("Name can't be empty."));
    try {
      updateSavedLocation(m.sub, c.req.param("locId"), name, world, +intArg(form.x), +intArg(form.y), +intArg(form.z));
      return c.redirect(`${back}?msg=` + encodeURIComponent("Updated."));
    } catch (e: any) {
      return c.redirect(`${back}?err=` + encodeURIComponent(e?.message || "Invalid coordinates."));
    }
  });

  // Upload a vanilla world .zip (admin). Streams to disk, unzips, validates,
  // places it in the game data dir (owned by uid 1001), and mv-imports it.
  app.post("/worlds/upload", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    // Owner-only: upload is the one path that writes files directly to the
    // game-data mount, so we keep its blast radius to the owner account.
    if (!m.owner) return redirect(c, "?err=" + encodeURIComponent("Only the owner can upload worlds."));
    const GAMEDATA = process.env.GAMEDATA_DIR || "/gamedata";
    const form = await c.req.parseBody();
    const file = form["world"];
    const nameRaw = String(form["name"] ?? "").trim();
    if (!(file instanceof Blob)) return redirect(c, "?err=" + encodeURIComponent("No file uploaded."));
    const mv = sanitizeWorldName(nameRaw || ((file as any).name || "world").replace(/\.zip$/i, ""));
    if (!mv) return redirect(c, "?err=" + encodeURIComponent("Invalid world name."));
    if (getWorldByMv(mv)) return redirect(c, "?err=" + encodeURIComponent("A world with that name already exists."));
    if (listAllWorlds().length >= GLOBAL_WORLD_CAP) return redirect(c, "?err=" + encodeURIComponent(`World cap reached (${GLOBAL_WORLD_CAP}).`));
    if (file.size > 150 * 1024 * 1024) return redirect(c, "?err=" + encodeURIComponent("World too large (max 150MB)."));

    const tmp = `/tmp/up-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    try {
      await $`mkdir -p ${tmp}/x`.quiet();
      await Bun.write(`${tmp}/w.zip`, file);                  // streams the blob to disk
      const un = await $`unzip -qq -o ${tmp}/w.zip -d ${tmp}/x`.quiet().nothrow();
      if (un.exitCode !== 0) { await $`rm -rf ${tmp}`.quiet().nothrow(); return redirect(c, "?err=" + encodeURIComponent("Not a valid .zip archive.")); }
      const found = (await $`find ${tmp}/x -maxdepth 4 -name level.dat -printf ${"%h\\n"}`.quiet().nothrow().text()).trim().split("\n").filter(Boolean);
      if (!found.length) { await $`rm -rf ${tmp}`.quiet().nothrow(); return redirect(c, "?err=" + encodeURIComponent("No level.dat found — is this a Minecraft world .zip?")); }
      const root = found[0];
      const dest = `${GAMEDATA}/${mv}`;
      if (await Bun.file(`${dest}/level.dat`).exists()) { await $`rm -rf ${tmp}`.quiet().nothrow(); return redirect(c, "?err=" + encodeURIComponent("That world folder already exists on disk.")); }
      await $`mkdir -p ${dest}`.quiet();
      await $`cp -a ${root}/. ${dest}/`.quiet();
      await $`chown -R 1001:1001 ${dest}`.quiet().nothrow();
      await $`rm -rf ${tmp}`.quiet().nothrow();
      await rcon(`mv import ${mv} normal`);
      await provisionWorld(mv, m.username);
      insertWorld({ id: randomUUID(), name: nameRaw || mv, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv), source: "upload-zip", status: "active" });
      return redirect(c, "?msg=" + encodeURIComponent(`Uploaded & imported '${mv}'. (Overworld only; nether/end aren't auto-split.)`));
    } catch (e: any) {
      await $`rm -rf ${tmp}`.quiet().nothrow();
      return redirect(c, "?err=" + encodeURIComponent("Upload failed: " + (e?.message || e)));
    }
  });
}
