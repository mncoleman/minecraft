import type { Hono } from "hono";
import { readdirSync, readFileSync } from "node:fs";
import { currentSession } from "./session.ts";
import { rcon, stripColor } from "./rcon.ts";
import { getPresence } from "./presence.ts";
import { shell, esc } from "./layout.ts";

// QualityArmory writes one yml per gun under <gamedata>/plugins/QualityArmory/newGuns.
// mc-auth mounts the game's data dir at GAMEDATA_DIR, so we read the live list.
const QA_GUNS_DIR = `${(process.env.GAMEDATA_DIR || "/gamedata").replace(/\/+$/, "")}/plugins/QualityArmory/newGuns`;
const SAFE = /^[A-Za-z0-9_]+$/; // gun + ammo ids must match this before they touch RCON

export interface Gun { id: string; label: string; ammo: string }

function parseGuns(): Gun[] {
  let files: string[];
  try { files = readdirSync(QA_GUNS_DIR).filter((f) => f.endsWith(".yml")); } catch { return []; }
  const guns: Gun[] = [];
  for (const f of files) {
    try {
      const txt = readFileSync(`${QA_GUNS_DIR}/${f}`, "utf8");
      const name = txt.match(/^name:\s*['"]?([^'"\n]+)/m)?.[1]?.trim() ?? "";
      if (!SAFE.test(name)) continue; // skip anything we couldn't cleanly parse
      const rawDn = txt.match(/^displayname:\s*['"]?([^'"\n]+)/m)?.[1]?.trim() ?? name;
      const label = stripColor(rawDn).replace(/&[0-9a-fk-or]/gi, "").trim() || name;
      let ammo = txt.match(/^ammotype:\s*['"]?([^'"\n]+)/m)?.[1]?.trim() ?? "";
      if (!SAFE.test(ammo)) ammo = "";
      guns.push({ id: name, label, ammo });
    } catch { /* skip unreadable file */ }
  }
  guns.sort((a, b) => a.label.localeCompare(b.label));
  return guns;
}

// Light cache: the gun list almost never changes; re-read at most every 30s.
let cache: { at: number; guns: Gun[] } | null = null;
function guns(): Gun[] {
  const now = Date.now();
  if (cache && now - cache.at < 30_000) return cache.guns;
  cache = { at: now, guns: parseGuns() };
  return cache.guns;
}

function modsPage(o: { username: string; admin: boolean; online: boolean; list: Gun[]; msg?: string; err?: string }): string {
  const rows = o.list.map((g) =>
    `<div class="world gun-row" data-q="${esc((g.label + " " + g.id).toLowerCase())}" style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap">
       <div><b>${esc(g.label)}</b> <span class="hint">${esc(g.id)}${g.ammo ? " &middot; ammo: " + esc(g.ammo) : ""}</span></div>
       <form method="post" action="/mods/give" style="margin:0">
         <input type="hidden" name="gun" value="${esc(g.id)}"/>
         <button class="btn-primary"${o.online ? "" : " disabled title=\"Join the game first\""}>Give me this</button>
       </form>
     </div>`).join("");

  const body = `
    <h1>Mods</h1>
    <p class="sub">Guns, powered by QualityArmory. Grab one below, then <b>left-click to fire</b> and <b>right-click to reload</b>. You'll get a stack of ammo with each gun.</p>
    ${o.online
      ? ""
      : '<div class="flash flash-err">You\'re not in the game right now. Hit <a href="/">Play</a> and join a world first &mdash; guns are handed to you in-game, so you need to be online to receive them.</div>'}
    ${o.list.length === 0
      ? '<div class="card">No guns found. Is the QualityArmory plugin installed and the server running?</div>'
      : `<input id="gunsearch" placeholder="Search ${o.list.length} guns..." oninput="filterGuns(this.value)" style="width:100%;margin:.2rem 0 1rem"/>
         <div id="gunlist">${rows}</div>`}
    <p class="hint" style="margin:1.2rem 0 0">Note: guns work fully, but appear as a plain item in the browser client &mdash; custom gun textures need a resource pack imported into Eaglercraft per-player, which isn't set up yet.</p>
    <script>
      function filterGuns(q){q=(q||"").toLowerCase();var rows=document.querySelectorAll('.gun-row');for(var i=0;i<rows.length;i++){var r=rows[i];r.style.display=r.getAttribute('data-q').indexOf(q)>=0?'':'none';}}
    </script>`;
  return shell({ title: "Mods", active: "mods", username: o.username, admin: o.admin, body, msg: o.msg, err: o.err });
}

export function mountMods(app: Hono): void {
  app.get("/mods", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const online = await getPresence().catch(() => []);
    const isOn = online.some((p) => p.name.toLowerCase() === s.username.toLowerCase());
    return c.html(modsPage({
      username: s.username, admin: !!s.admin, online: isOn, list: guns(),
      msg: c.req.query("msg") ?? undefined, err: c.req.query("err") ?? undefined,
    }));
  });

  // Hand the requesting player a gun + ammo via RCON. Requires them to be online
  // (the item goes into their in-game inventory). The gun id is validated against
  // the parsed list, so only known, [A-Za-z0-9_] names ever reach RCON.
  app.post("/mods/give", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const gunId = String((await c.req.parseBody()).gun ?? "");
    const gun = guns().find((g) => g.id === gunId);
    if (!gun) return c.redirect("/mods?err=" + encodeURIComponent("Unknown gun."));
    const online = await getPresence().catch(() => []);
    if (!online.some((p) => p.name.toLowerCase() === s.username.toLowerCase())) {
      return c.redirect("/mods?err=" + encodeURIComponent("You must be in the game first — hit Play and join a world."));
    }
    try {
      // QA console syntax: qa give <item> <player> <amount>
      await rcon(`qa give ${gun.id} ${s.username} 1`);
      if (gun.ammo) await rcon(`qa give ${gun.ammo} ${s.username} 64`);
      return c.redirect("/mods?msg=" + encodeURIComponent(`Gave you a ${gun.label}${gun.ammo ? " + ammo" : ""}. Check your hotbar!`));
    } catch (e: any) {
      return c.redirect("/mods?err=" + encodeURIComponent("Failed to give the gun: " + (e?.message || e)));
    }
  });
}
