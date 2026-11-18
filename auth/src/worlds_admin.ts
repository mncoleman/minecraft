import type { Hono, Context } from "hono";
import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { currentSession } from "./session.ts";
import { db, type User } from "./db.ts";
import {
  type World, type WorldNote,
  listAllWorlds, listWorldsOwnedBy, listWorldsSharedWith, sharesForWorld,
  getWorld, getWorldByMv, insertWorld, sanitizeWorldName,
  isLobby, provisionWorld, shareWorld, unshareWorld, reassignWorldOwner, deleteWorld, isProtectedWorld, teleportTo, setPendingDestination,
  getNote, saveNote, getLocation, fetchWorldSeed, readMvWorld, liveWorldExists,
  recordTeleport, recentTeleports, listSavedLocations, saveLocation, updateSavedLocation, deleteSavedLocation,
  createWorldCommand, difficultyCommand, tpCoordsCommand,
} from "./worlds.ts";
import { getPresence, serverOfPlayer, type OnlinePlayer } from "./presence.ts";
import { SERVERS, enabledServers, isEnabled, parseServer, serverLabel, type ServerId } from "./servers.ts";
import { ownedWorldCount } from "./db.ts";
import { visibleOnlineUsernames, listFriends, areFriends } from "./friends.ts";

function canAccess(w: World, m: { sub: string; admin: boolean }): boolean {
  // Private friends-only server: every logged-in player has full access to every
  // world (entry, build, command pages). Ownership still gates rename/delete/share.
  return true;
}
import { rcon, stripColor } from "./rcon.ts";
import { config } from "./config.ts";
import { shell, icon, edBadge, pageHead, tiles, type Tile } from "./layout.ts";

const GLOBAL_WORLD_CAP = Number(process.env.WORLD_CAP || 8);
// Names currently mid-upload. A retried upload attempt (see the client's
// auto-retry on connection drop) reuses the same name; without this, an
// earlier attempt that's still importing server-side wouldn't be caught by
// the getWorldByMv/level.dat-exists checks and a second attempt could race it
// into the same destination folder.
const uploadsInProgress = new Set<string>();
// How many worlds a non-admin may own. Admins are bound only by the global cap.
const PER_USER_WORLD_CAP = Number(process.env.PER_USER_WORLD_CAP || 10);
// Bukkit's default world folders. The shared lobby is the world named "world" and
// is intentionally NOT in our DB, so getWorldByMv() would not catch it. Block these
// explicitly from create/register: claiming one would hand the caller WorldGuard
// ownership + world-scoped op commands in the shared lobby.
// On 26, extra worlds live in world/dimensions/minecraft/<name>, next to the
// lobby's own overworld/the_nether/the_end folders: those names are reserved too.
const RESERVED_MV_WORLDS = new Set(["world", "world_nether", "world_the_end", "overworld", "the_nether", "the_end"]);
const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
// Sanitize a user-supplied world seed before it goes into an `mv create ... -s`
// RCON command. Keep only letters, digits, dash and underscore so it stays a
// single token (no spaces / flag injection), allowing negative numeric seeds
// and text seeds. Capped in length; empty string means "no seed given".
function sanitizeSeed(s: string): string {
  return (s ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}
function userById(id: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}
function userByUsername(name: string): User | null {
  return db.query("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(name) as User | null;
}
// Chunkbase seed map. 1.8 server worlds are Java 1.12 (pre-set); 26 worlds use
// Chunkbase's default (latest) version. The seed is what makes the map correct;
// the user just confirms the version dropdown.
function mapUrl(seed: string, srv: ServerId): string {
  const platform = srv === "18" ? "&platform=java_1_12" : "";
  return `https://www.chunkbase.com/apps/seed-map#seed=${encodeURIComponent(seed)}${platform}&dimension=overworld`;
}
// ── page ─────────────────────────────────────────────────────────────────────
function worldsPage(me: { sub: string; username: string; admin: boolean; owner: boolean }, onlineAll: OnlinePlayer[], msg?: string, err?: string): string {
  const on = new Set(enabledServers());
  const owned = listWorldsOwnedBy(me.sub).filter((w) => on.has(w.server));
  const shared = listWorldsSharedWith(me.sub).filter((w) => on.has(w.server));
  // Admins also see every other active world (not owned by / shared with them).
  const mine = new Set([...owned, ...shared].map((w) => w.id));
  const lobbies = enabledServers().map((s) => getWorldByMv("world", s)).filter((w): w is World => !!w);
  // Which server am I in right now? (null = not in game). Drives the banner and
  // whether each world's Hop is one click or "open the other Play button".
  const meOnline = onlineAll.find((p) => p.name.toLowerCase() === me.username.toLowerCase()) ?? null;
  const here: ServerId | null = meOnline ? meOnline.server : null;
  // Everyone has access to every world, so every non-owned active world is listed.
  const others = listAllWorlds().filter((w) => w.status === "active" && on.has(w.server) && !mine.has(w.id) && !isLobby(w.mv_world_name));
  // Privacy: non-admins only see friends, world co-members, and themselves online.
  const visible = me.admin ? null : visibleOnlineUsernames(me.sub);
  const online = visible ? onlineAll.filter((p) => visible.has(p.name.toLowerCase())) : onlineAll;
  const atUserCap = !me.admin && ownedWorldCount(me.sub) >= PER_USER_WORLD_CAP;

  const memberRows = (w: World) =>
    sharesForWorld(w.id).map((m) =>
      `<tr><td>${esc(m.username)}</td><td style="text-align:right"><form method="post" action="/worlds/${w.id}/unshare" style="margin:0"><input type="hidden" name="grantee" value="${m.grantee_user_id}"/><button class="btn-danger">revoke</button></form></td></tr>`,
    ).join("") || `<tr><td colspan="2" class="hint">no one yet — grant someone above</td></tr>`;

  const hopButton = (w: World) => {
    if (here && here !== w.server) {
      // In the other edition right now: Hop still works (it queues), but say how.
      return `<form method="post" action="/worlds/${w.id}/hop" style="margin:0" title="You're on ${serverLabel(here)}. This is a ${serverLabel(w.server)} world: hop queues it, then open Play ${serverLabel(w.server)}."><button class="btn-ghost" style="opacity:.6">Hop in (${serverLabel(w.server)}) →</button></form>`;
    }
    return `<form method="post" action="/worlds/${w.id}/hop" style="margin:0"><button class="btn-ghost">Hop in →</button></form>`;
  };
  const cardLinks = (w: World) =>
    `<span class="row" style="margin:0;gap:.4rem">
      ${w.seed ? `<code class="hint" data-copy style="font-size:.74rem" title="World seed (${w.server === "18" ? "Java 1.12.2" : "Java 26"}) — click to copy">${esc(w.seed)}</code>` : ""}
      <a class="pill" href="/worlds/${w.id}/notes">${icon("note")} Notes</a>
      ${isLobby(w.mv_world_name) && !me.admin ? "" : `<a class="pill" href="/worlds/${w.id}/console">${icon("terminal")} Command</a>`}
      ${w.seed ? `<a class="pill" href="${mapUrl(w.seed, w.server)}" target="_blank" rel="noopener" title="Open the Chunkbase seed map${w.server === "18" ? " — set the version to Java 1.12" : ""}">${icon("map")} Map</a>` : ""}
      ${hopButton(w)}
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

  // One world → a compact row card: name + edition, meta line, actions.
  const worldRow = (w: World, meta: string, title = esc(w.name)) => `<div class="world">
    <div class="wname"><b>${title}</b> <code>${esc(w.mv_world_name)}</code></div>
    ${meta ? `<div class="wmeta">${meta}</div>` : ""}
    <div class="wacts">${cardLinks(w)}</div>
  </div>`;
  const ownerName = (w: World) => esc(userById(w.owner_user_id)?.username || "?");

  // One online player → a row with a "Join →" button when the caller can build
  // in that player's current world (registered + shared/owned/admin, or the open
  // lobby which isn't a registered world). Clicking it teleports you to them.
  const onlineRow = (p: OnlinePlayer) => {
    const isSelf = p.name.toLowerCase() === me.username.toLowerCase();
    const target = getWorldByMv(p.world, p.server);
    const joinable = !isSelf && (!target || canAccess(target, me));
    const right = isSelf
      ? '<span class="hint">that\'s you</span>'
      : joinable
        ? `<form method="post" action="/worlds/hop-to" style="margin:0"><input type="hidden" name="mv" value="${esc(p.world)}"/><input type="hidden" name="server" value="${p.server}"/><button class="btn-ghost">Join${here && here !== p.server ? ` (${serverLabel(p.server)})` : ""} →</button></form>`
        : '<span class="hint">no access</span>';
    return `<div class="row" style="justify-content:space-between;margin:.3rem 0"><span><span class="dot on"></span><b>${esc(p.name)}</b> ${edBadge(p.server)} <span class="hint">in ${esc(p.world)}</span></span>${right}</div>`;
  };

  const servers = enabledServers();
  const onCount = (s: ServerId) => onlineAll.filter((p) => p.server === s).length;
  const allActive = listAllWorlds().filter((w) => w.status === "active" && on.has(w.server) && !isLobby(w.mv_world_name));
  const worldsOn = (s: ServerId) => allActive.filter((w) => w.server === s).length + (lobbies.some((l) => l.server === s) ? 1 : 0);
  const SRV_NOTE: Record<ServerId, string> = { "18": "Classic 1.8 client · Paper 1.12.2", "26": "Modern Minecraft 26 · Paper 26.2" };

  const serverPanel = (s: ServerId) => {
    const lobby = lobbies.find((l) => l.server === s);
    const mineHere = owned.filter((w) => w.server === s);
    const othersHere = others.filter((w) => w.server === s);
    const n = onCount(s);
    return `<section class="srv srv-${s}">
      <div class="srv-h"><div><div class="name">${icon("server")} Minecraft ${serverLabel(s)}</div><div class="ver">${SRV_NOTE[s]}</div></div>
        <span class="chip${n ? " live" : ""}">${n ? '<span class="dot on"></span>' : ""}${n} online</span></div>
      <div class="srv-b">
        ${lobby ? `<div class="sect">Shared World</div>${worldRow(lobby, "The main world everyone shares. Anyone can build.", "Shared World")}` : ""}
        <div class="sect">Your worlds (${mineHere.length})</div>
        ${mineHere.length ? mineHere.map((w) => worldRow(w, "You own this world")).join("") : `<div class="empty">You don't own a ${serverLabel(s)} world yet. <a href="#create">Create one →</a></div>`}
        <div class="sect">Everyone's worlds (${othersHere.length})</div>
        ${othersHere.length ? othersHere.map((w) => worldRow(w, `Owner: ${ownerName(w)}`)).join("") : '<div class="empty">No other worlds on this server.</div>'}
      </div>
    </section>`;
  };

  const body = `
    ${pageHead({
      eyebrow: "Command center",
      title: `${icon("globe")} Worlds`,
      sub: "Every world on both servers. Anyone can visit and build in any world. Hit <b>Play</b> first (it connects you), then <b>Hop in</b> or <b>Join</b> to teleport.",
      actions: `<a class="pill" href="/">${icon("play")} Play</a><a class="pill" href="#create">${icon("plus")} New world</a>`,
    })}
    ${tiles([
      ...servers.map((s): Tile => ({ k: `Online · ${serverLabel(s)}`, v: onCount(s), f: `${worldsOn(s)} worlds on ${serverLabel(s)}`, tone: s, icon: "activity" })),
      { k: "Worlds", v: allActive.length + lobbies.length, f: servers.map((s) => `${worldsOn(s)} on ${serverLabel(s)}`).join(" · "), icon: "globe" },
      { k: "Your worlds", v: owned.length, f: me.admin ? "no limit for admins" : `limit ${PER_USER_WORLD_CAP}`, tone: "acc", icon: "user" },
    ])}
    ${servers.length > 1 ? `<div class="card" style="border-color:${here === "26" ? "var(--c26-line)" : here ? "var(--c18-line)" : "var(--line)"}">${here
      ? `${icon("activity")} You're playing on ${edBadge(here)} <b>${serverLabel(here)}</b> right now. Its worlds are one click away. ${here === "26" ? "1.8" : "26"} worlds stay on the ${here === "26" ? "1.8" : "26"} server: open <b>Play ${here === "26" ? "1.8" : "26"}</b> to visit them.`
      : `You're not in the game. Each world lives on one server, ${edBadge("18")} or ${edBadge("26")}. <b>Hop in</b> queues your trip, then the matching Play button drops you there.`}</div>` : ""}

    <div class="split">${servers.map(serverPanel).join("")}</div>

    <div class="cols">
      <div>
        <h2>${icon("users")} Who's online</h2>
        ${online.length
          ? `<div class="card">${online.map(onlineRow).join("")}</div>`
          : me.admin
            ? '<div class="empty">No one is online right now. Hit <b>Play</b> to jump on.</div>'
            : '<div class="empty">None of your friends are online right now. You only see friends and people you share a world with here. Add friends on the <a href="/friends">Friends</a> tab.</div>'}
        <div class="card hint" style="margin-top:.8rem"><b style="color:var(--text)">What's a world?</b> A Minecraft map. <b style="color:var(--text)">Play</b> drops you in the <b style="color:var(--text)">Shared World</b>, which belongs to everyone. Create your own world for a space you own: it saves as you build, and everyone can visit.</div>
      </div>
      <div id="create">
        <h2>${icon("plus")} Create a world</h2>
        <div class="card">
      <p class="hint" style="margin:.1rem 0 .7rem">Pick a short name (letters, numbers and dashes). You'll become its owner; everyone can visit and build in it.</p>
      ${atUserCap
        ? `<p class="hint" style="margin:0">You've reached your limit of ${PER_USER_WORLD_CAP} worlds. Ask an admin if you need more.</p>`
        : `<form id="create-form" method="post" action="/worlds/create" class="row" style="margin:0"><input name="name" placeholder="my world name" required/><input name="seed" placeholder="seed (optional)"/>${servers.length > 1
            ? `<select name="server" title="Which server the world lives on (it stays there)">${servers.map((sv) => `<option value="${sv}"${sv === (here ?? "26") ? " selected" : ""}>Minecraft ${serverLabel(sv)}</option>`).join("")}</select>`
            : ""}<button class="btn-primary">Create</button></form>
           <div class="progress-wrap" id="create-progress"><div class="progress-track"><div class="progress-fill" id="create-fill"></div></div><div class="progress-label" id="create-label"></div></div>
           <p class="hint" style="margin:.5rem 0 0">Leave the seed blank for a random world, or paste a seed (a number, or any word) to generate a specific one.${me.admin ? "" : ` You can create up to ${PER_USER_WORLD_CAP} worlds.`}</p>`}
      ${isEnabled("18") ? `<div style="margin-top:.9rem;padding-top:.9rem;border-top:1px solid var(--line)">
        <div class="hint" style="margin-bottom:.4rem">${icon("upload")} Upload a world you built in singleplayer ${edBadge("18")}</div>
        <form id="upload-form" method="post" action="/worlds/upload" enctype="multipart/form-data" class="row"><input type="file" name="world" accept=".zip" required/><input name="name" placeholder="world name"/><button class="btn-ghost">Upload .zip</button></form>
        <div class="progress-wrap" id="upload-progress"><div class="progress-track"><div class="progress-fill" id="upload-fill"></div></div><div class="progress-label" id="upload-label"></div></div>
        <p class="hint" style="margin:.5rem 0 0">In singleplayer: open the world's Backup/Edit menu, choose <b>Convert to Vanilla</b>, then upload the .zip here. Give it a new name. Uploads go to the 1.8 server.</p>
      </div>` : ""}
      ${me.admin ? `
      <div style="margin-top:.9rem;padding-top:.9rem;border-top:1px solid var(--line)">
        <div class="hint" style="margin-bottom:.4rem">${icon("shield")} Admin tools</div>
        <form method="post" action="/worlds/register" class="row"><input name="mv" placeholder="existing world folder (e.g. cliffbuild)" required/><input name="name" placeholder="display name"/><button class="btn-ghost">Register existing</button></form>
        <p class="hint" style="margin:.6rem 0 0">Register applies to the <b>1.8</b> server only. Manage users &amp; invites in the <a href="/admin">Admin</a> tab.</p>
      </div>` : ""}
        </div>
      </div>
    </div>
    <script>
    (function(){
      function wireProgress(formId, progressId, fillId, labelId, opts){
        var form = document.getElementById(formId);
        if (!form) return;
        var wrap = document.getElementById(progressId);
        var fill = document.getElementById(fillId);
        var label = document.getElementById(labelId);

        // One HTTP attempt. Resolves {ok:true, url} on a completed response,
        // {ok:false} on a network-level failure (the connection dying mid-upload
        // is common enough on large, long-running uploads that this is retried,
        // not just reported).
        function attemptOnce(url, body){
          return new Promise(function(resolve){
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            if (opts.raw) xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            if (opts.determinate) {
              xhr.upload.addEventListener('progress', function(ev){
                if (!ev.lengthComputable) return;
                var pct = Math.round((ev.loaded / ev.total) * 100);
                fill.style.width = pct + '%';
                label.textContent = pct < 100 ? ('Uploading… ' + pct + '%') : 'Upload complete — importing on the server, this can take a moment for large worlds…';
              });
            }
            xhr.addEventListener('load', function(){ resolve({ ok: true, url: xhr.responseURL || '/worlds' }); });
            xhr.addEventListener('error', function(){ resolve({ ok: false }); });
            xhr.addEventListener('abort', function(){ resolve({ ok: false }); });
            xhr.send(body);
          });
        }

        function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

        form.addEventListener('submit', function(e){
          var btn = form.querySelector('button');
          if (btn.disabled) return;
          e.preventDefault();
          btn.disabled = true;
          wrap.classList.add('active');
          label.classList.remove('err');
          if (opts.determinate) {
            fill.classList.remove('indeterminate');
            fill.style.width = '0%';
            label.textContent = 'Uploading… 0%';
          } else {
            fill.classList.add('indeterminate');
            fill.style.width = '';
            label.textContent = opts.busyLabel;
          }

          var url = form.action;
          var body;
          if (opts.raw) {
            // Raw-body upload: send the file's bytes directly (no multipart
            // wrapping — Bun's multipart parser drops large bodies intermittently).
            var fileInput = form.querySelector('input[type=file]');
            var file = fileInput.files[0];
            var nameInput = form.querySelector('input[name=name]');
            url += '?filename=' + encodeURIComponent(file.name) + '&name=' + encodeURIComponent(nameInput ? nameInput.value : '');
            body = file;
          } else {
            body = new FormData(form);
          }

          var maxAttempts = opts.retries || 1;
          (async function run(){
            for (var attempt = 1; attempt <= maxAttempts; attempt++) {
              var result = await attemptOnce(url, body);
              if (result.ok) {
                window.location.href = result.url;
                return;
              }
              if (attempt < maxAttempts) {
                label.textContent = 'Connection dropped — retrying (' + (attempt + 1) + '/' + maxAttempts + ')…';
                label.classList.add('err');
                await sleep(1500);
                label.classList.remove('err');
                if (opts.determinate) fill.style.width = '0%';
              } else {
                label.textContent = 'Connection kept dropping after ' + maxAttempts + ' tries — this looks like a network issue on this connection rather than the server. Try again, ideally on a more stable connection (e.g. wired instead of Wi-Fi).';
                label.classList.add('err');
                fill.classList.remove('indeterminate');
                fill.style.width = '0%';
                btn.disabled = false;
              }
            }
          })();
        });
      }
      wireProgress('create-form', 'create-progress', 'create-fill', 'create-label', {determinate:false, busyLabel:'Creating your world…'});
      wireProgress('upload-form', 'upload-progress', 'upload-fill', 'upload-label', {determinate:true, raw:true, retries:6});
    })();
    </script>
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
  if (isLobby(w.mv_world_name)) { // everyone belongs to the lobby
    for (const u of db.query("SELECT username FROM users ORDER BY username COLLATE NOCASE").all() as Array<{ username: string }>) out.push({ username: u.username, isOwner: false });
    return out;
  }
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
    ${pageHead({
      eyebrow: `Notes · Minecraft ${serverLabel(w.server)}`,
      title: `${icon("note")} ${esc(isLobby(w.mv_world_name) ? "Shared World" : w.name)} ${edBadge(w.server)}`,
      sub: `<a href="/worlds">← All worlds</a> · Shared notepad for this world: everyone can read and edit. ${when ? `Last saved ${when}${editor ? " by " + esc(editor) : ""}.` : "No notes yet."}`,
      actions: `<a class="pill" href="/worlds/${w.id}/console">${icon("terminal")} Command</a>`,
    })}
    <div class="card">
      <form method="post" action="/worlds/${w.id}/notes">
        <textarea name="body" placeholder="Build plans, coordinates, to-dos…">${esc(note?.body || "")}</textarea>
        <button class="btn-primary" style="margin-top:.6rem">Save notes</button>
      </form>
    </div>`;
  return shell({ title: "Notes", active: "worlds", username: meCtx.username, admin: meCtx.admin, body, msg, err });
}

// ── Command Center page ──────────────────────────────────────────────────────
function consolePage(w: World, meCtx: { sub: string; username: string; admin: boolean; owner: boolean }, onlineAll: OnlinePlayer[], curDiff: string, msg?: string, err?: string, global = false): string {
  // Only this world's server matters here (same names on the other server are a
  // different session).
  const online = onlineAll.filter((p) => p.server === w.server);
  const elsewhere = onlineAll.find((p) => p.server !== w.server && p.name.toLowerCase() === meCtx.username.toLowerCase());
  const byName = new Map(online.map((p) => [p.name.toLowerCase(), p]));
  const meOn = byName.get(meCtx.username.toLowerCase());
  const inWorld = !!meOn && meOn.world === w.mv_world_name;
  const meHere = !!(inWorld && meOn && typeof meOn.x === "number");
  const recent = recentTeleports(meCtx.sub, w.server, w.mv_world_name); // per-world only
  const saved = listSavedLocations(meCtx.sub, w.server, w.mv_world_name); // per-world only
  const isModern = SERVERS[w.server].modern;

  const status = !meOn
    ? (elsewhere
      ? `<span class="badge" style="background:#5a4a22;color:#ffe0a3">you're on the ${serverLabel(elsewhere.server)} server — this is a ${serverLabel(w.server)} world, open Play ${serverLabel(w.server)}</span>`
      : `<span class="badge" style="background:#5a2230;color:#ffb3c0">offline — hit Play ${serverLabel(w.server)} to run commands</span>`)
    : inWorld
      ? `<span class="badge badge-ok">in this world${typeof meOn.x === "number" ? ` @ ${meOn.x}, ${meOn.y}, ${meOn.z}` : ""}</span>`
      : `<span class="badge" style="background:#5a4a22;color:#ffe0a3">online in ${esc(meOn.world)} — coord/time/weather need you inside ${esc(w.mv_world_name)}</span>`;

  // Privacy: non-admins only see (and can jump to) players they could see online.
  const seeable = meCtx.admin ? null : visibleOnlineUsernames(meCtx.sub);
  // One row per player (name, where they are, Go): wraps on a phone, unlike a
  // native <select> whose long labels get clipped.
  const playerRows = worldMembers(w).filter((mem) => !seeable || seeable.has(mem.username.toLowerCase())).map((mem) => {
    const on = byName.get(mem.username.toLowerCase());
    const live = on && typeof on.x === "number" ? { world: on.world, x: on.x, y: on.y as number, z: on.z as number } : null;
    const loc = live || getLocation(mem.username, w.server);
    const where = on
      ? (live ? `online · ${esc(live.world)} (${live.x}, ${live.y}, ${live.z})` : "online")
      : loc ? `last seen · ${esc(loc.world)} (${loc.x}, ${loc.y}, ${loc.z})`
      : "never seen";
    return `<div class="row" style="justify-content:space-between;margin:0;padding:.35rem 0;border-top:1px solid var(--line);flex-wrap:nowrap">
      <span style="min-width:0"><span class="dot${on ? " on" : ""}"></span><b>${esc(mem.username)}</b><div class="hint" style="font-size:.8rem">${where}</div></span>
      <form method="post" action="/worlds/${w.id}/run" style="margin:0;flex:none"><input type="hidden" name="cmd" value="tp_player"/><input type="hidden" name="target" value="${esc(mem.username)}"/><button class="btn-primary"${!on && !loc ? " disabled" : ""}>Go</button></form>
    </div>`;
  }).join("");

  const card = (title: string, inner: string, note?: string) => `
    <div class="card">
      <div class="cc-t">${title}</div>
      <form method="post" action="/worlds/${w.id}/run" class="row" style="align-items:flex-end;margin:0">${inner}<button class="btn-primary">Run</button></form>
      ${note ? `<p class="hint" style="margin:.45rem 0 0">${note}</p>` : ""}
    </div>`;

  // Dashboard card of one-click buttons (one form per button group; the clicked
  // button's name/value is submitted alongside the hidden cmd).
  const cc = (title: string, cmd: string, field: string, opts: string[], current?: string, note?: string) => `
    <div class="card">
      <div class="cc-t">${title}</div>
      <form method="post" action="/worlds/${w.id}/run" style="margin:0">
        <input type="hidden" name="cmd" value="${cmd}"/>
        <div class="cc-btns">${opts.map((o) => `<button name="${field}" value="${o}" class="${o === current ? "btn-primary" : "btn-ghost"}">${o}</button>`).join("")}</div>
      </form>
      ${note ? `<p class="hint" style="margin:0">${note}</p>` : ""}
    </div>`;

  // hidden world+x+y+z+label fields for a "go to this exact spot" tp_loc form
  const locFields = (world: string, x: number, y: number, z: number, label: string) =>
    `<input type="hidden" name="cmd" value="tp_loc"><input type="hidden" name="world" value="${esc(world)}"><input type="hidden" name="x" value="${x}"><input type="hidden" name="y" value="${y}"><input type="hidden" name="z" value="${z}"><input type="hidden" name="label" value="${esc(label)}">`;

  const recentBlock = `
    <div class="card">
      <div style="font-weight:600;margin-bottom:.5rem">Recently teleported <span class="hint" style="font-weight:400">· ${esc(w.name)}</span></div>
      ${recent.length ? recent.map((r) => {
        // Player teleports store target_user_id, so resolve the CURRENT name now
        // (stays correct after a rename); coord/custom teleports use the label.
        const disp = r.target_user_id ? "→ " + (userById(r.target_user_id)?.username ?? "unknown") : (r.label || "");
        return `
        <div class="row" style="justify-content:space-between;margin:.3rem 0">
          <span>${disp ? "<b>" + esc(disp) + "</b> " : ""}<span class="hint">${esc(r.world)} (${r.x}, ${r.y}, ${r.z})</span></span>
          <form method="post" action="/worlds/${w.id}/run" style="margin:0">${locFields(r.world, r.x, r.y, r.z, disp)}<button class="btn-ghost">Go again →</button></form>
        </div>`; }).join("") : '<p class="hint">No teleports yet — use the controls above.</p>'}
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
    <style>
      .cc-head{display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap;margin:.2rem 0 .4rem}
      .cc-head h1{margin:0}
      .cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:.8rem;margin:.8rem 0}
      .cc-grid .card{margin:0;display:flex;flex-direction:column;gap:.55rem}
      .cc-wide{grid-column:1/-1}
      .cc-t{font-weight:600;display:flex;align-items:center;gap:.45rem}
      .cc-t .hint{font-weight:400}
      .cc-btns{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:.4rem}
      .cc-btns button{min-width:0;padding:.5rem .45rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cc-sec{margin:1.6rem 0 0;font:700 .72rem var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:.5rem}
      .cc-sec::after{content:"";flex:1;height:1px;background:var(--line)}
      #cc-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;padding:.6rem .9rem;border-radius:10px;font-size:.9rem;z-index:50;display:none;box-shadow:0 6px 24px #0008}
      #cc-toast.ok{background:#234e36;color:#d6f5e1;display:block}
      #cc-toast.err{background:#5a2230;color:#ffd0da;display:block}
      #cc-toast.busy{background:#222a35;color:#cdd6e2;display:block}
      .cc-busy{opacity:.55;pointer-events:none}
    </style>
    ${pageHead(global ? {
      eyebrow: "Command center · follows you",
      title: `${icon("terminal")} Command Center`,
      sub: `Commands go to the world you're in right now: <b>${esc(isLobby(w.mv_world_name) ? "Shared World" : w.name)}</b> ${edBadge(w.server)} on the ${serverLabel(w.server)} server. Move to another world and this page follows.`,
      actions: `<a class="pill" href="/worlds/${w.id}/console">${icon("globe")} This world's page</a><a class="pill" href="/worlds/${w.id}/notes">${icon("note")} Notes</a>${status}`,
    } : {
      eyebrow: `Command center · Minecraft ${serverLabel(w.server)}`,
      title: `${icon("terminal")} ${esc(isLobby(w.mv_world_name) ? "Shared World" : w.name)} <code>${esc(w.mv_world_name)}</code> ${edBadge(w.server)}`,
      sub: `<a href="/worlds">← All worlds</a> · <a href="/command">Command Center for wherever you are →</a>`,
      actions: `<a class="pill" href="/worlds/${w.id}/notes">${icon("note")} Notes</a>${status}`,
    })}
    ${tiles([
      { k: "You", v: inWorld ? "In this world" : meOn ? "Elsewhere" : elsewhere ? "Other server" : "Offline", sm: true, f: meHere && meOn ? `${meOn.x}, ${meOn.y}, ${meOn.z}` : meOn ? `in ${esc(meOn.world)}` : `hit Play ${serverLabel(w.server)}`, tone: inWorld ? "18" : "acc", icon: "user" },
      { k: "Here now", v: online.filter((p) => p.world === w.mv_world_name).length, f: "players in this world", tone: w.server, icon: "activity" },
      { k: "Saved places", v: saved.length, f: "yours, in this world", icon: "map" },
      { k: "Difficulty", v: curDiff || "unknown", sm: true, icon: "shield" },
    ])}

    <div class="cc-sec">World controls</div>
    <div class="cc-grid">
      ${cc("Game mode (you)", "gamemode", "mode", ["creative", "survival", "adventure", "spectator"])}
      ${cc("Time", "time", "val", ["day", "noon", "night", "midnight"])}
      ${cc("Weather", "weather", "val", ["clear", "rain", "thunder"])}
      ${cc("Difficulty", "difficulty", "val", ["peaceful", "easy", "normal", "hard"], curDiff, `Now <b>${esc(curDiff || "unknown")}</b>, saved for this world.`)}
    </div>

    <div class="cc-sec">Travel</div>
    <div class="cc-grid">
      ${card("Teleport to coordinates", `<input type="hidden" name="cmd" value="tp_coords"/>
        <span>X<br><input name="x" type="number" required style="width:84px"></span>
        <span>Y<br><input name="y" type="number" required style="width:84px"></span>
        <span>Z<br><input name="z" type="number" required style="width:84px"></span>`,
        "Teleports you to these coordinates in this world.")}
      <div class="card">
        <div class="cc-t">Teleport to a player</div>
        <div>${playerRows || '<p class="hint" style="margin:0">No one here you can jump to yet (friends and people you share a world with show up).</p>'}</div>
        <p class="hint" style="margin:.2rem 0 0">Live if they're online, otherwise their last-known spot.</p>
      </div>
      ${card("Give item (to you)", `<input type="hidden" name="cmd" value="give"/>
        <input name="item" placeholder="e.g. diamond_pickaxe" required style="flex:1;min-width:150px">
        <span>×<input name="count" type="number" value="1" min="1" max="64" style="width:64px"></span>`,
        isModern ? "Modern ids like <code>diamond</code>, <code>cherry_planks</code>." : "1.12.2 ids like <code>diamond</code>, <code>oak_log</code>.")}
      ${meCtx.owner ? card("Raw command (owner)", `<input type="hidden" name="cmd" value="raw"/>
        <input name="raw" placeholder="no slash, e.g. difficulty peaceful" required style="flex:1;min-width:200px">`,
        icon("alert") + " Runs verbatim on the server console.") : ""}
    </div>

    <div class="cc-sec">Places</div>
    <div class="cc-grid">
      <div class="cc-wide">${savedBlock}</div>
      <div class="cc-wide">${recentBlock}</div>
    </div>
    <div id="cc-toast" role="status"></div>
    <script>
    (function(){
      var toast=document.getElementById('cc-toast'),tm;
      function show(cls,txt,ms){clearTimeout(tm);toast.className=cls;toast.textContent=txt;if(ms)tm=setTimeout(function(){toast.className='';},ms);}
      document.addEventListener('submit',function(e){
        var f=e.target;
        if(!f.action||!/\\/worlds\\/[^/]+\\/run$/.test(f.action))return;
        if(!window.fetch||!window.FormData)return;
        e.preventDefault();
        var body;
        try{body=new URLSearchParams(new FormData(f,e.submitter));}catch(_){body=new URLSearchParams(new FormData(f));}
        var cmd=body.get('cmd')||'';
        f.classList.add('cc-busy');show('busy','Running…');
        fetch(f.action,{method:'POST',body:body,credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'}})
          .then(function(r){var u=new URL(r.url);var err=u.searchParams.get('err'),msg=u.searchParams.get('msg');
            f.classList.remove('cc-busy');
            if(err)show('err',err,6000);else show('ok',msg||'Done.',3500);
            if(!err&&/^tp_/.test(cmd))setTimeout(function(){location.reload();},900);})
          .catch(function(){f.classList.remove('cc-busy');show('err','Request failed — try again.',6000);});
      });
    })();
    </script>
  `;
  // On the global page every form says so, and the handlers send you back here.
  const out = global ? body.replace(/(<form method="post" action="\/worlds\/[^"]+\/(?:run|saveloc)[^"]*"[^>]*>)/g, '$1<input type="hidden" name="from" value="command">') : body;
  return shell({ title: "Command Center", active: global ? "command" : "worlds", username: meCtx.username, admin: meCtx.admin, body: out, msg, err });
}

/** Where a Command Center form goes back to: the global page or the world's. */
function ccBack(w: World, form: Record<string, unknown>): string {
  if (form.from === "map") return "/map/api/ack"; // the Map tab calls these routes over fetch and reads the JSON ack
  return form.from === "command" ? "/command" : `/worlds/${w.id}/console`;
}

// ── Global Command Center: the world you're in right now ─────────────────────
function commandIdlePage(me: { username: string; admin: boolean }, title: string, text: string, msg?: string, err?: string): string {
  const body = `
    ${pageHead({ eyebrow: "Command center · follows you", title: `${icon("terminal")} Command Center`, sub: "Runs commands in whichever world you're standing in, on whichever server you're on." })}
    <div class="card" style="border-color:var(--c26-line)">
      <h3>${title}</h3>
      <p class="hint" style="margin:0 0 .8rem">${text}</p>
      <div class="row" style="margin:0"><a class="pill" href="/">${icon("play")} Play</a><a class="pill" href="/worlds">${icon("globe")} Worlds</a><a class="pill" href="/command">Check again</a></div>
    </div>`;
  return shell({ title: "Command Center", active: "command", username: me.username, admin: me.admin, body, msg, err });
}

/**
 * Send a player to a world on a given server, or queue it. If they're online on
 * THAT server, teleport now; otherwise (offline, or in the other edition) queue a
 * pending hop that fires when they join that server. Returns the redirect query.
 */
async function hopOrQueue(username: string, mv: string, srv: ServerId): Promise<string> {
  const on = await serverOfPlayer(username);
  if (on && on.server === srv) {
    const resp = stripColor(await teleportTo(username, mv, srv));
    if (!/cannot be found|not online|no player|couldn't be found|not found/i.test(resp)) {
      return "?msg=" + encodeURIComponent(`Sent you to ${mv} — switch to your game tab.`);
    }
  }
  setPendingDestination(username, mv, srv);
  const label = serverLabel(srv);
  if (on && on.server !== srv) {
    return "?msg=" + encodeURIComponent(`${mv} is on the ${label} server and you're on ${serverLabel(on.server)}. Queued: open Play ${label} and you'll drop into ${mv} automatically.`);
  }
  return "?msg=" + encodeURIComponent(`Queued — hit Play ${label} and you'll drop into ${mv} automatically.`);
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
    // Which server the world lives on (it stays there). Default: 1.8 when only
    // one server is configured; the form always sends it when there are two.
    const srv: ServerId = parseServer(form.server) ?? "18";
    if (!isEnabled(srv)) return redirect(c, "?err=" + encodeURIComponent("That server isn't available."));
    if (mv.length < 1) return redirect(c, "?err=" + encodeURIComponent("Invalid world name."));
    if (RESERVED_MV_WORLDS.has(mv)) return redirect(c, "?err=" + encodeURIComponent("That world name is reserved."));
    if (getWorldByMv(mv, srv)) return redirect(c, "?err=" + encodeURIComponent("A world with that name already exists."));
    // The cap is per server (each has its own disk-heavy world set).
    if (listAllWorlds().filter((x) => x.server === srv && !isLobby(x.mv_world_name)).length >= GLOBAL_WORLD_CAP) return redirect(c, "?err=" + encodeURIComponent(`The ${serverLabel(srv)} server is at its world limit (${GLOBAL_WORLD_CAP}). Ask an admin.`));
    // Optional custom seed. Restrict to a safe charset so it can't inject extra
    // RCON args/flags (no spaces). Minecraft accepts numeric or text seeds; a
    // leading "-" allows negative numeric seeds. Blank → Multiverse picks random.
    const seedInput = sanitizeSeed(String(form.seed ?? ""));
    try {
      // World generation can take longer than the default RCON window, so give
      // this call a generous timeout; the response carries "Complete!" on success.
      let out = "";
      try {
        out = stripColor(await rcon(createWorldCommand(mv, seedInput, srv), 30000, srv));
      } catch { /* may have timed out while still generating — detect below */ }
      // Success if Multiverse confirmed, OR the world actually exists now. A slow
      // create whose RCON response timed out still finishes server-side: adopt it
      // rather than orphan it (issue #31). Poll briefly for it to appear.
      let exists = /complete|created!/i.test(out) || await liveWorldExists(mv, srv);
      for (let i = 0; !exists && i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        exists = await liveWorldExists(mv, srv);
      }
      if (!exists) {
        // Truly didn't get created (and not a pre-existing folder we should adopt
        // — Register is for that). Surface a clear, non-scary error.
        return redirect(c, "?err=" + encodeURIComponent("Could not create that world right now — the name may be in use, or it's taking too long. Try a different name or try again shortly."));
      }
      await provisionWorld(mv, m.username, srv);
      insertWorld({ id: randomUUID(), name: name || mv, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv, srv), source: "created", status: "active", server: srv });
      return redirect(c, "?msg=" + encodeURIComponent(`World '${mv}' created on the ${serverLabel(srv)} server.`));
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
    if (RESERVED_MV_WORLDS.has(mv)) return redirect(c, "?err=" + encodeURIComponent("That world is reserved and can't be registered."));
    if (getWorldByMv(mv, "18")) return redirect(c, "?err=" + encodeURIComponent("Already registered."));
    try {
      // Register is a 1.8-server tool (adopts an existing 1.12 world folder).
      await provisionWorld(mv, m.username, "18");
      insertWorld({ id: randomUUID(), name, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv, "18"), source: "import", status: "active", server: "18" });
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
    if (isLobby(w.mv_world_name)) return redirect(c, "?err=" + encodeURIComponent("The lobby is open to everyone; it can't be shared or reassigned."));
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
    if (isLobby(w.mv_world_name)) return redirect(c, "?err=" + encodeURIComponent("The lobby is open to everyone; it can't be shared or reassigned."));
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

  // Reassign a world's owner (admin only). Bypasses the per-user world cap (it's an
  // administrative transfer). The previous owner is kept as a shared build member.
  app.post("/worlds/:id/reassign", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    if (!m.admin) return c.redirect("/admin?err=" + encodeURIComponent("Admins only."));
    const w = getWorld(c.req.param("id"));
    if (!w) return c.redirect("/admin?err=" + encodeURIComponent("World not found."));
    if (isLobby(w.mv_world_name)) return c.redirect("/admin?err=" + encodeURIComponent("The lobby is open to everyone; it can't be shared or reassigned."));
    const form = await c.req.parseBody();
    const newOwner = userByUsername(String(form.username ?? "").trim());
    if (!newOwner) return c.redirect("/admin?err=" + encodeURIComponent("Pick an existing user to reassign to."));
    if (newOwner.id === w.owner_user_id) return c.redirect("/admin?msg=" + encodeURIComponent("That user already owns this world."));
    try {
      await reassignWorldOwner(w, newOwner, m.sub);
      return c.redirect("/admin?msg=" + encodeURIComponent(`'${w.name}' reassigned to ${newOwner.username}. The previous owner keeps build access as a shared member.`));
    } catch (e: any) {
      const msg = /UNIQUE/i.test(e?.message || "")
        ? `${newOwner.username} already has a world named '${w.name}'. Rename one first.`
        : (e?.message || String(e));
      return c.redirect("/admin?err=" + encodeURIComponent("Reassign failed: " + msg));
    }
  });

  // Permanently delete a world (admin only). Type-to-confirm is enforced again
  // server-side. Evacuates occupants to the lobby, then tears the world down.
  app.post("/worlds/:id/delete", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    if (!m.admin) return c.redirect("/admin?err=" + encodeURIComponent("Admins only."));
    const w = getWorld(c.req.param("id"));
    if (!w) return c.redirect("/admin?err=" + encodeURIComponent("World not found."));
    if (isProtectedWorld(w.mv_world_name)) return c.redirect("/admin?err=" + encodeURIComponent("That world is protected and can't be deleted."));
    const form = await c.req.parseBody();
    if (String(form.confirm ?? "").trim() !== w.mv_world_name) {
      return c.redirect("/admin?err=" + encodeURIComponent("Type the exact world name to confirm deletion."));
    }
    // Evacuate anyone currently in the world to the lobby first (can't delete a
    // world players are standing in).
    try {
      for (const p of await getPresence()) {
        if (p.server === w.server && p.world === w.mv_world_name) await teleportTo(p.name, "world", w.server).catch(() => {});
      }
    } catch { /* best-effort */ }
    const res = await deleteWorld(w);
    if (!res.ok) return c.redirect("/admin?err=" + encodeURIComponent("Delete failed: " + res.error));
    return c.redirect("/admin?msg=" + encodeURIComponent(`Deleted world '${w.mv_world_name}'.`));
  });

  // One-click hop: teleport the caller into a world they can access (must be online in-game).
  app.post("/worlds/:id/hop", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    try {
      return redirect(c, await hopOrQueue(m.username, w.mv_world_name, w.server));
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
    const srv: ServerId = parseServer(form.server) ?? "18";
    if (!mv) return redirect(c, "?err=" + encodeURIComponent("No destination."));
    if (!isEnabled(srv)) return redirect(c, "?err=" + encodeURIComponent("That server isn't available."));
    const w = getWorldByMv(mv, srv);
    if (w && !canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    try {
      return redirect(c, await hopOrQueue(m.username, mv, srv));
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
    if (isLobby(w.mv_world_name) && !m.admin) return redirect(c, "?err=" + encodeURIComponent("The lobby's Command Center is admin-only."));
    const curDiff = ((await readMvWorld(w.mv_world_name, w.server)).difficulty || "").toLowerCase(); // live
    return c.html(consolePage(w, m, await getPresence(), curDiff, c.req.query("msg"), c.req.query("err")));
  });
  // Global Command Center: resolves your current server + world from presence
  // (the same source get_status / resolveServer use) and shows that world's controls.
  app.get("/command", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const msg = c.req.query("msg"), err = c.req.query("err");
    const all = await getPresence();
    const here = all.find((p) => p.name.toLowerCase() === m.username.toLowerCase());
    if (!here) return c.html(commandIdlePage(m, "You're not in the game right now", "Hit <b>Play</b> (1.8 or 26) and join, then come back. This page picks up the world you're in automatically.", msg, err));
    const w = getWorldByMv(here.world, here.server);
    if (!w || w.status !== "active") return c.html(commandIdlePage(m, `You're in <code>${esc(here.world)}</code> on ${serverLabel(here.server)}`, "That place isn't one of the panel's worlds (for example the Nether or the End), so there are no controls for it. Head back to a world, or use the <a href=\"/worlds\">Worlds</a> page.", msg, err));
    if (isLobby(w.mv_world_name) && !m.admin) return c.html(commandIdlePage(m, `You're in the Shared World on ${serverLabel(here.server)}`, "The Shared World's Command Center is admin-only. Hop into your own world (or anyone's) on the <a href=\"/worlds\">Worlds</a> page and this page will follow you there.", msg, err));
    const curDiff = ((await readMvWorld(w.mv_world_name, w.server)).difficulty || "").toLowerCase();
    c.header("Cache-Control", "no-store");
    return c.html(consolePage(w, m, all, curDiff, msg, err, true));
  });

  app.post("/worlds/:id/run", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    if (!canAccess(w, m)) return redirect(c, "?err=" + encodeURIComponent("You don't have access to that world."));
    if (isLobby(w.mv_world_name) && !m.admin) return redirect(c, "?err=" + encodeURIComponent("The lobby's Command Center is admin-only."));
    const form = await c.req.parseBody();
    const back = (q: string) => c.redirect(`${ccBack(w, form)}?${q}`);
    const cmd = String(form.cmd ?? "");

    // Raw passthrough — owner only (equivalent to being op in-game).
    if (cmd === "raw") {
      if (!m.owner) return back("err=" + encodeURIComponent("Raw command is owner-only."));
      const raw = String(form.raw ?? "").trim().replace(/^\//, "");
      if (!raw) return back("err=" + encodeURIComponent("Empty command."));
      try { const out = stripColor(await rcon(raw, 5000, w.server)); return back("msg=" + encodeURIComponent(out.trim() || ("Ran: " + raw))); }
      catch (e: any) { return back("err=" + encodeURIComponent("Failed: " + (e?.message || e))); }
    }

    // Everything else acts on YOU and needs you in-game.
    const srv = w.server;
    const modern = SERVERS[srv].modern;
    const online = (await getPresence()).filter((p) => p.server === srv);
    const meOn = online.find((p) => p.name.toLowerCase() === m.username.toLowerCase());
    if (!meOn) return back("err=" + encodeURIComponent(`You must be in the game on the ${serverLabel(srv)} server to run commands — hit Play ${serverLabel(srv)} first.`));
    const inWorld = meOn.world === w.mv_world_name;
    // A teleport may only land you in a world you could enter yourself (registered
    // worlds via canAccess; unregistered ones like world_nether stay open).
    const mayEnter = (mv: string) => { const t = getWorldByMv(mv, srv); return !t || canAccess(t, m); };
    const noEntry = (mv: string) => back("err=" + encodeURIComponent(`You don't have access to ${mv}.`));

    let command = "";
    let dest: { world: string; x: number; y: number; z: number; label: string; targetUserId?: string | null } | null = null;
    try {
      switch (cmd) {
        case "tp_coords": {
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first (you're in ${meOn.world}).`));
          const x = intArg(form.x), y = intArg(form.y), z = intArg(form.z);
          command = tpCoordsCommand(m.username, meOn.world, x, y, z, srv);
          dest = { world: meOn.world, x: +x, y: +y, z: +z, label: "" };
          break;
        }
        case "tp_player": {
          const target = playerArg(form.target, w);
          if (!m.admin && !visibleOnlineUsernames(m.sub).has(target.toLowerCase())) return back("err=" + encodeURIComponent("You can only jump to your friends and people you share a world with."));
          const tuid = userByUsername(target)?.id ?? null; // stable id → name resolves live later
          const tOn = online.find((p) => p.name.toLowerCase() === target.toLowerCase());
          if (tOn) {
            if (!mayEnter(tOn.world)) return noEntry(tOn.world);
            command = `tp ${m.username} ${target}`;
            if (typeof tOn.x === "number") dest = { world: tOn.world, x: tOn.x, y: tOn.y as number, z: tOn.z as number, label: "→ " + target, targetUserId: tuid };
          } else {
            const loc = getLocation(target, srv);
            if (!loc) return back("err=" + encodeURIComponent(`No known location for ${target} on this server yet.`));
            if (!mayEnter(loc.world)) return noEntry(loc.world);
            if (loc.world !== meOn.world) await teleportTo(m.username, loc.world, srv);
            command = tpCoordsCommand(m.username, loc.world, loc.x, loc.y, loc.z, srv);
            dest = { world: loc.world, x: loc.x, y: loc.y, z: loc.z, label: "→ " + target, targetUserId: tuid };
          }
          break;
        }
        case "tp_loc": {
          const world = sanitizeWorldName(String(form.world ?? ""));
          if (!world) return back("err=" + encodeURIComponent("Bad destination."));
          if (!mayEnter(world)) return noEntry(world);
          const x = intArg(form.x), y = intArg(form.y), z = intArg(form.z);
          if (meOn.world !== world) await teleportTo(m.username, world, srv);
          command = tpCoordsCommand(m.username, world, x, y, z, srv);
          dest = { world, x: +x, y: +y, z: +z, label: String(form.label ?? "").slice(0, 40) };
          break;
        }
        case "gamemode":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = `gamemode ${pickEnum(form.mode, ["survival", "creative", "adventure", "spectator"])} ${m.username}`;
          break;
        case "difficulty":
          command = difficultyCommand(w.mv_world_name, pickEnum(form.val, ["peaceful", "easy", "normal", "hard"]), srv);
          break;
        case "time":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = modern
            ? `execute as ${m.username} at @s run time set ${pickEnum(form.val, ["day", "noon", "night", "midnight"])}`
            : `execute ${m.username} ~ ~ ~ time set ${pickEnum(form.val, ["day", "noon", "night", "midnight"])}`;
          break;
        case "weather":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = modern
            ? `execute as ${m.username} at @s run weather ${pickEnum(form.val, ["clear", "rain", "thunder"])}`
            : `execute ${m.username} ~ ~ ~ weather ${pickEnum(form.val, ["clear", "rain", "thunder"])}`;
          break;
        case "give":
          if (!inWorld) return back("err=" + encodeURIComponent(`Stand in ${w.mv_world_name} first.`));
          command = `give ${m.username} ${itemArg(form.item)} ${intArg(form.count, 1, 64)}`;
          break;
        default:
          return back("err=" + encodeURIComponent("Unknown command."));
      }
    } catch (e: any) {
      return back("err=" + encodeURIComponent(e?.message || "Invalid input."));
    }
    try {
      const out = stripColor(await rcon(command, 5000, srv));
      if (dest) recordTeleport(m.sub, srv, dest.world, dest.x, dest.y, dest.z, dest.label, dest.targetUserId ?? null);
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
    const form = await c.req.parseBody();
    const back = ccBack(w, form);
    const name = String(form.name ?? "").trim().slice(0, 40);
    if (!name) return c.redirect(`${back}?err=` + encodeURIComponent("Give the location a name."));
    if (listSavedLocations(m.sub, w.server, w.mv_world_name).length >= 50) return c.redirect(`${back}?err=` + encodeURIComponent("You've hit the 50 saved-locations limit for this world."));
    try {
      saveLocation(m.sub, w.server, name, w.mv_world_name, +intArg(form.x), +intArg(form.y), +intArg(form.z));
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
    return c.redirect(`${ccBack(w, await c.req.parseBody())}?msg=` + encodeURIComponent("Deleted."));
  });
  app.post("/worlds/:id/saveloc/:locId", async (c) => {
    const m = await me(c); if (!m) return c.redirect("/login");
    const w = getWorld(c.req.param("id"));
    if (!w) return redirect(c, "?err=" + encodeURIComponent("World not found."));
    const form = await c.req.parseBody();
    const back = ccBack(w, form);
    const name = String(form.name ?? "").trim().slice(0, 40);
    const world = sanitizeWorldName(String(form.world ?? "")) || w.mv_world_name;
    if (!name) return c.redirect(`${back}?err=` + encodeURIComponent("Name can't be empty."));
    try {
      updateSavedLocation(m.sub, w.server, c.req.param("locId"), name, world, +intArg(form.x), +intArg(form.y), +intArg(form.z));
      return c.redirect(`${back}?msg=` + encodeURIComponent("Updated."));
    } catch (e: any) {
      return c.redirect(`${back}?err=` + encodeURIComponent(e?.message || "Invalid coordinates."));
    }
  });

  // Upload a vanilla world .zip (admin). Streams to disk, unzips, validates,
  // places it in the game data dir (owned by uid 1001), and mv-imports it.
  app.post("/worlds/upload", async (c) => {
    // Grab the body stream up front so every bail-out path below can drain it.
    // Caddy is already relaying client bytes to us as they arrive regardless of
    // what we do with them; sending a response while a large body is still mid-
    // flight and unread is the classic "upstream responds before the request
    // finishes" pattern that makes reverse proxies kill the connection with a
    // 5xx instead of just passing our response through. Confirmed reproducible
    // server-side (loopback, no client network involved): any early return here
    // with a large body still arriving unread 5xx'd 10/10 times.
    const body = c.req.raw.body;
    const drain = async () => {
      if (!body) return;
      try {
        const reader = body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch { /* client gave up mid-drain — nothing left to do */ }
    };
    const bail = async (q: string) => { await drain(); return redirect(c, q); };

    const m = await me(c);
    if (!m) { await drain(); return c.redirect("/login"); }
    // Any logged-in player may upload (private friends-only server).
    if (!isEnabled("18")) return bail("err=" + encodeURIComponent("World uploads go to the 1.8 server, which is retired."));
    const GAMEDATA = SERVERS["18"].gamedataDir;
    const MAX_UPLOAD = 400 * 1024 * 1024;
    // Raw-body upload, not multipart/form-data: Bun's FormData/multipart parser
    // is unreliable on large bodies — it drops the connection intermittently at
    // arbitrary points well under any configured size cap (matches known upstream
    // issues in oven-sh/bun's multipart handling). The client streams the file
    // directly as the request body instead; name/filename ride as query params.
    const nameRaw = String(c.req.query("name") ?? "").trim();
    const origFilename = String(c.req.query("filename") ?? "world.zip");
    const mv = sanitizeWorldName(nameRaw || origFilename.replace(/\.zip$/i, ""));
    if (!mv) return bail("?err=" + encodeURIComponent("Invalid world name."));
    if (RESERVED_MV_WORLDS.has(mv)) return bail("?err=" + encodeURIComponent("That name is reserved."));
    if (getWorldByMv(mv, "18")) return bail("?err=" + encodeURIComponent("A world with that name already exists."));
    if (listAllWorlds().filter((x) => x.server === "18" && !isLobby(x.mv_world_name)).length >= GLOBAL_WORLD_CAP) return bail("?err=" + encodeURIComponent(`World cap reached (${GLOBAL_WORLD_CAP}).`));
    const declaredSize = Number(c.req.header("content-length") ?? "0");
    if (declaredSize > MAX_UPLOAD) return bail("?err=" + encodeURIComponent("World too large (max 400MB)."));
    if (!body) return redirect(c, "?err=" + encodeURIComponent("No file uploaded."));
    // The client auto-retries the same name on a dropped connection; without this
    // gate a retry firing while the first attempt is still importing could race
    // it into the same destination folder (see uploadsInProgress above).
    if (uploadsInProgress.has(mv)) return bail("?err=" + encodeURIComponent("An upload for that name is already in progress — give it a minute."));
    uploadsInProgress.add(mv);

    const tmp = `/tmp/up-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    try {
      await $`mkdir -p ${tmp}/x`.quiet();
      // Stream straight to disk (constant memory) instead of buffering the
      // whole body as a Blob/FormData field first.
      const writer = Bun.file(`${tmp}/w.zip`).writer();
      const reader = body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_UPLOAD) {
          await reader.cancel().catch(() => {});
          await writer.end();
          await $`rm -rf ${tmp}`.quiet().nothrow();
          return redirect(c, "?err=" + encodeURIComponent("World too large (max 400MB)."));
        }
        writer.write(value);
      }
      await writer.end();
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
      // Upload is a 1.8-server tool (1.12 world folder layout).
      await rcon(`mv import ${mv} normal`, 5000, "18");
      await provisionWorld(mv, m.username, "18");
      insertWorld({ id: randomUUID(), name: nameRaw || mv, mv_world_name: mv, owner_user_id: m.sub, world_type: "normal", seed: await fetchWorldSeed(mv, "18"), source: "upload-zip", status: "active", server: "18" });
      return redirect(c, "?msg=" + encodeURIComponent(`Uploaded & imported '${mv}'. (Overworld only; nether/end aren't auto-split.)`));
    } catch (e: any) {
      await $`rm -rf ${tmp}`.quiet().nothrow();
      return redirect(c, "?err=" + encodeURIComponent("Upload failed: " + (e?.message || e)));
    } finally {
      uploadsInProgress.delete(mv);
    }
  });
}
