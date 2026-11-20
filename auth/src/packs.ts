// ── Custom Packs tab (26 only) ───────────────────────────────────────────────
// Browse the content plugins on the 26 server and give yourself their items.
//
//   QualityArmory  guns, ammo, grenades/misc, armor. Read straight from the
//                  plugin's yml files on the shared game-data mount (read-only:
//                  this page never writes into the game data directory).
//   BlockShips / Windfarer  vehicles built from blocks; no items to give, so
//                  they get a short how-to card.
//
// Give: any logged-in player (owner's call, 2026-11-20) who is online on 26 can
// give THEMSELVES an item. The player name always comes from the session, the
// item must exactly match a name scanned from disk, and the amount is clamped.
// Everything goes through RCON (`qa give <item> <player> [amount]`).

import type { Hono, Context } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { currentSession, rateLimited } from "./session.ts";
import { shell, esc, pageHead, panel, tiles } from "./layout.ts";
import { rcon, stripColor } from "./rcon.ts";
import { SERVERS, isEnabled } from "./servers.ts";
import { serverOfPlayer } from "./presence.ts";
import { config } from "./config.ts";

const QA_DIR = () => `${SERVERS["26"].gamedataDir}/plugins/QualityArmory`;
const PACK_URL = () => `${config.publicBaseUrl}/26/packs/qualityarmory.zip`;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,48}$/;

type Kind = "gun" | "ammo" | "misc" | "armor";
interface Item {
  name: string;        // QualityArmory item id (what `qa give` takes)
  label: string;       // display name, colour codes stripped
  kind: Kind;
  group: string;       // section heading
  tags: string[];      // e.g. "Full-auto", "Suppressed", "9mm"
  stat: string;        // one-line stats
}

// weapontype → section, in display order.
const GUN_GROUPS: Array<[string, string]> = [
  ["PISTOL", "Hand guns"],
  ["SMG", "SMGs"],
  ["RIFLE", "Rifles"],
  ["SNIPER", "Snipers"],
  ["SHOTGUN", "Shotguns"],
  ["BIG_GUN", "Heavy"],
  ["RPG", "Launchers"],
  ["FLAMER", "Flamethrower"],
  ["LAZER", "Energy weapons"],
];
const OTHER_GROUPS = ["Ammo", "Grenades & gear", "Armor"];

/** Top-level `key: value` scalars from a QualityArmory yml (enough for listing). */
function scalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!m || m[2] === "") continue;
    out[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const cleanLabel = (s: string) => s.replace(/[&§][0-9a-fk-orx]/gi, "").trim();

async function readKind(sub: string, kind: Kind): Promise<Item[]> {
  let files: string[] = [];
  try { files = (await readdir(`${QA_DIR()}/${sub}`)).filter((f) => f.endsWith(".yml")); } catch { return []; }
  const items: Item[] = [];
  for (const f of files) {
    let y: Record<string, string>;
    try { y = scalars(await readFile(`${QA_DIR()}/${sub}/${f}`, "utf8")); } catch { continue; }
    const name = y.name;
    if (!name || !SAFE_NAME.test(name) || y.invalid === "true" || /debug/i.test(name)) continue;
    const label = cleanLabel(y.displayname || name) || name;
    if (kind === "gun") {
      const type = (y.weapontype || "").toUpperCase();
      const group = GUN_GROUPS.find(([t]) => t === type)?.[1] ?? "Other guns";
      const tags: string[] = [];
      if (y.isAutomatic === "true") tags.push("Full-auto");
      if (/silenc|suppress/i.test(y.weaponsounds || "") || /silenc|suppress/i.test(name) || /(^|[^a-z])m4a1s$/i.test(name)) tags.push("Suppressed");
      if (y.ammotype) tags.push(y.ammotype);
      const stat = [y.damage && `${y.damage} dmg`, y.maxbullets && `${y.maxbullets} rounds`].filter(Boolean).join(" · ");
      items.push({ name, label, kind, group, tags, stat });
    } else if (kind === "ammo") {
      items.push({ name, label, kind, group: "Ammo", tags: [], stat: y.maxItemStack ? `stack ${y.maxItemStack}` : "" });
    } else if (kind === "misc") {
      items.push({ name, label, kind, group: "Grenades & gear", tags: y.MiscType ? [cleanLabel(y.MiscType).toLowerCase().replace(/_/g, " ")] : [], stat: "" });
    } else {
      items.push({ name, label, kind, group: "Armor", tags: [], stat: "" });
    }
  }
  return items;
}

let cache: { at: number; items: Item[] } = { at: 0, items: [] };
async function allItems(): Promise<Item[]> {
  if (Date.now() - cache.at < 60_000) return cache.items;
  const lists = await Promise.all([
    readKind("newGuns", "gun"), readKind("ammo", "ammo"), readKind("misc", "misc"), readKind("armor", "armor"),
  ]);
  const items = lists.flat().sort((a, b) => a.label.localeCompare(b.label));
  cache = { at: Date.now(), items };
  return items;
}

// Non-ammo gives are one RCON call each, so keep those small.
const maxAmount = (k: Kind) => (k === "ammo" ? 256 : k === "gun" ? 3 : 8);

// ── page ─────────────────────────────────────────────────────────────────────
function itemCard(it: Item): string {
  const max = maxAmount(it.kind);
  const def = it.kind === "ammo" ? 64 : 1;
  const tags = it.tags.map((t) => `<span class="badge${t === "Full-auto" || t === "Suppressed" ? " badge-owner" : " badge-muted"}">${esc(t)}</span>`).join(" ");
  return `<div class="card pk-item" data-q="${esc((it.label + " " + it.name + " " + it.tags.join(" ") + " " + it.group).toLowerCase())}">
  <img class="pk-icon" src="/26/packs/icons/${encodeURIComponent(it.name)}.png" alt="" loading="lazy" width="96" height="96" onerror="this.style.visibility='hidden'" />
  <div class="pk-top"><b>${esc(it.label)}</b> <code>${esc(it.name)}</code></div>
  ${tags || it.stat ? `<div class="pk-meta">${tags}${it.stat ? ` <span class="hint">${esc(it.stat)}</span>` : ""}</div>` : ""}
  <form class="pk-give" data-item="${esc(it.name)}">
    <input type="number" name="amount" min="1" max="${max}" value="${def}" aria-label="Amount" />
    <button type="submit">Give</button>
  </form>
</div>`;
}

const PAGE_CSS = `<style>
.pk-item{display:flex;flex-direction:column;gap:.35rem;padding:.75rem .85rem}
.pk-icon{display:block;margin:0 auto;width:96px;height:96px;image-rendering:auto}
.pk-top code{font-size:.72rem;color:var(--dim)}
.pk-meta{display:flex;gap:.3rem;flex-wrap:wrap;align-items:center}
.pk-give{display:flex;gap:.4rem;margin-top:auto}
.pk-give input{width:4.5rem}
.pk-give button{flex:1}
.pk-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.pk-filter{display:flex;gap:.5rem;flex-wrap:wrap;margin:.4rem 0 .8rem}
.pk-filter input{flex:1;min-width:200px}
#pk-toast{position:fixed;right:1rem;bottom:1rem;z-index:50;max-width:min(26rem,90vw);display:none}
.pk-sect h2{margin:1.2rem 0 .3rem}
</style>`;

const PAGE_JS = `<script>(function(){
var q=document.getElementById("pk-q"),toast=document.getElementById("pk-toast"),t;
function show(msg,ok){toast.textContent=msg;toast.className="flash"+(ok?"":" flash-err");toast.style.display="block";clearTimeout(t);t=setTimeout(function(){toast.style.display="none"},4500);}
if(q)q.addEventListener("input",function(){var v=q.value.trim().toLowerCase();
  document.querySelectorAll(".pk-item").forEach(function(el){el.style.display=!v||el.dataset.q.indexOf(v)>=0?"":"none"});
  document.querySelectorAll(".pk-sect").forEach(function(s){var any=[].some.call(s.querySelectorAll(".pk-item"),function(el){return el.style.display!=="none"});s.style.display=any?"":"none"});});
document.querySelectorAll(".pk-give").forEach(function(f){f.addEventListener("submit",function(e){e.preventDefault();
  var b=f.querySelector("button");b.disabled=true;
  var body=new URLSearchParams({item:f.dataset.item,amount:f.amount.value});
  fetch("/packs/give",{method:"POST",body:body,credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){show(j.message||(j.ok?"Done":"Failed"),j.ok)})
  .catch(function(){show("Couldn't reach the panel. Try again.",false)}).finally(function(){b.disabled=false});});});
})();</script>`;

async function packsPage(m: { username: string; admin: boolean }, online26: boolean): Promise<string> {
  const items = await allItems();
  const guns = items.filter((i) => i.kind === "gun");
  const groups = [...GUN_GROUPS.map(([, g]) => g), "Other guns", ...OTHER_GROUPS];
  const sections = groups.map((g) => {
    const list = items.filter((i) => i.group === g);
    if (!list.length) return "";
    return `<section class="pk-sect"><h2>${esc(g)} <span class="hint">${list.length}</span></h2><div class="grid pk-grid">${list.map(itemCard).join("")}</div></section>`;
  }).join("");

  const status = online26
    ? `<span class="badge">You're online on 26: items go straight into your inventory</span>`
    : `<span class="badge badge-muted">Join the 26 server to give yourself items</span>`;

  const qaHelp = `<p style="margin:.2rem 0">Pick an item below and press <b>Give</b>; it lands in your inventory on the 26 server.
In game: <b>left-click</b> to shoot, <b>right-click</b> or <b>F</b> to reload, and <b>sneak</b> to aim down the sights.
Guns need matching ammo in your inventory. In-game, <code>/qa craft</code> opens the same list as a menu.</p>
<p class="hint" style="margin:.4rem 0 0">Gun models and sounds come from a resource pack the server offers when you join: accept it.
If you said no, rejoin and accept, or download it: <a href="${esc(PACK_URL())}">qualityarmory.zip</a>.</p>`;

  const vehicles = `<div class="grid">
<div class="card"><b>BlockShips</b> <span class="hint">ships &amp; airships</span>
<p style="margin:.4rem 0 0">Rideable ships with collision that stay where you park them. They come as ship kits: run <code>/blockships help</code> in game.</p></div>
<div class="card"><b>Windfarer</b> <span class="hint">planes &amp; airships you build</span>
<p style="margin:.4rem 0 0">Build your craft from blocks, put a <b>sign</b> on it with the craft type on the first line (e.g. <code>Airskiff</code> or <code>Airship</code>), then right-click the sign to pilot it. <code>/release</code> lets go.</p></div>
</div>`;

  const body = PAGE_CSS +
    pageHead({ eyebrow: "26 server", title: "Custom Packs", sub: "Guns, gear and vehicles added to the 26 server. Give yourself items here instead of typing commands.", actions: status }) +
    tiles([
      { k: "Guns", v: guns.length, tone: "26" },
      { k: "Ammo types", v: items.filter((i) => i.kind === "ammo").length },
      { k: "Full-auto", v: guns.filter((g) => g.tags.includes("Full-auto")).length },
      { k: "Suppressed", v: guns.filter((g) => g.tags.includes("Suppressed")).length },
    ]) +
    panel("QualityArmory: guns &amp; gear", qaHelp) +
    panel("Vehicles", vehicles) +
    `<div class="pk-filter"><input id="pk-q" type="search" placeholder="Search: ak47, sniper, full-auto, 9mm…" autocomplete="off"/></div>` +
    (items.length ? sections : `<div class="empty">Couldn't read the QualityArmory item list right now.</div>`) +
    `<div id="pk-toast" role="status" aria-live="polite"></div>` + PAGE_JS;

  return shell({ title: "Custom Packs", active: "packs", username: m.username, admin: m.admin, body, wide: true });
}

// ── routes ───────────────────────────────────────────────────────────────────
export function mountPacks(app: Hono): void {
  app.get("/packs", async (c: Context) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    if (!isEnabled("26")) return c.text("The 26 server isn't set up.", 404);
    const where = await serverOfPlayer(s.username);
    return c.html(await packsPage({ username: s.username, admin: !!s.admin }, where?.server === "26"));
  });

  app.post("/packs/give", async (c: Context) => {
    const s = await currentSession(c);
    if (!s) return c.json({ ok: false, message: "Please log in again." }, 401);
    if (!isEnabled("26")) return c.json({ ok: false, message: "The 26 server isn't set up." }, 404);
    if (rateLimited("packs:" + s.sub, 12, 60)) return c.json({ ok: false, message: "Slow down a little, then try again." }, 429);

    const form = await c.req.parseBody();
    const name = String(form.item ?? "");
    const item = (await allItems()).find((i) => i.name === name);
    if (!item) return c.json({ ok: false, message: "Unknown item." }, 400);
    const player = s.username;
    if (!SAFE_NAME.test(player)) return c.json({ ok: false, message: "Your username can't be used with this command." }, 400);

    const where = await serverOfPlayer(player);
    if (where?.server !== "26") return c.json({ ok: false, message: "Join the 26 server first, then press Give again." }, 409);

    const n = Math.max(1, Math.min(maxAmount(item.kind), Math.floor(Number(form.amount) || 1)));
    try {
      let reply = "";
      if (item.kind === "ammo") {
        reply = stripColor(await rcon(`qa give ${item.name} ${player} ${n}`, 5000, "26"));
      } else {
        for (let i = 0; i < n; i++) reply = stripColor(await rcon(`qa give ${item.name} ${player}`, 5000, "26"));
      }
      const ok = /adding/i.test(reply);
      return c.json(ok
        ? { ok: true, message: `Gave you ${n > 1 ? n + " × " : ""}${item.label}.` }
        : { ok: false, message: reply.trim() || "The server didn't confirm the give." }, ok ? 200 : 502);
    } catch (e) {
      return c.json({ ok: false, message: "Couldn't reach the 26 server: " + (e as Error).message }, 502);
    }
  });
}
