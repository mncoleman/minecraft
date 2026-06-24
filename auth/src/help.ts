import type { Hono } from "hono";
import { currentSession } from "./session.ts";
import { shell } from "./layout.ts";

// ── Editable content ─────────────────────────────────────────────────────────
// Add/adjust entries here; the page re-renders from these arrays.

type Cmd = { cmd: string; desc: string; op?: boolean };

const BASICS: Cmd[] = [
  { cmd: "Click the screen", desc: "Capture the mouse to look around (Esc releases it)." },
  { cmd: "W A S D / Space", desc: "Move / jump. Double-tap W to sprint; Space x2 to fly in creative." },
  { cmd: "E", desc: "Open your inventory. In creative, search and grab any item." },
  { cmd: "Left / Right click", desc: "Break blocks / place blocks (or use items)." },
  { cmd: "T  or  /", desc: "Open chat. Type messages, or commands starting with /." },
  { cmd: "F5", desc: "Switch camera (first-person / third-person)." },
  { cmd: "/seed", desc: "Show the world seed." },
  { cmd: "/help", desc: "List the commands available to you in-game." },
];

const OP_CMDS: Cmd[] = [
  { cmd: "/gamemode creative", desc: "Switch yourself to creative (also survival, spectator, adventure).", op: true },
  { cmd: "/gamemode survival <name>", desc: "Switch another player's mode.", op: true },
  { cmd: "/defaultgamemode creative", desc: "Set what everyone spawns in.", op: true },
  { cmd: "/time set day", desc: "Set time (day / night / noon / midnight).", op: true },
  { cmd: "/weather clear", desc: "Set weather (clear / rain / thunder).", op: true },
  { cmd: "/difficulty peaceful", desc: "No hostile mobs (also easy / normal / hard).", op: true },
  { cmd: "/gamerule keepInventory true", desc: "Keep your items when you die.", op: true },
  { cmd: "/gamerule doDaylightCycle false", desc: "Freeze the time of day.", op: true },
  { cmd: "/give <name> <item> [n]", desc: "Give items, e.g. /give Matthew minecraft:diamond_block 64.", op: true },
  { cmd: "/tp <x> <y> <z>", desc: "Teleport to coordinates (or /tp <player>).", op: true },
  { cmd: "/setworldspawn", desc: "Set the world's spawn point to where you stand.", op: true },
];

const TIPS: string[] = [
  "Your builds are saved on the server — they persist even when you log off, and other allowed players can keep building while you're away.",
  "Best performance: use Chrome or Firefox on a computer (the fast WASM client). On Safari or iPhone, use the compatible client link on the play page.",
  "Your in-game username must match your account name — if you get kicked asking you to rename, set it in Main Menu → Edit Profile → Username.",
  "Press Esc → Options → Video Settings and lower Render Distance if the game feels laggy.",
  "In creative, press E and use the search box to find any block instantly. Middle-click a block in the world to copy it to your hand.",
];

const LINKS: { label: string; url: string; note: string }[] = [
  { label: "Minecraft Wiki", url: "https://minecraft.wiki", note: "Blocks, items, mobs, mechanics — the definitive reference." },
  { label: "Crafting recipes (1.8)", url: "https://minecraft.wiki/w/Crafting", note: "How to craft tools, blocks, and gear." },
  { label: "Eaglercraft", url: "https://eaglercraft.com", note: "About the browser-based client this server uses." },
  { label: "Beginner's guide", url: "https://minecraft.wiki/w/Tutorials/Beginner%27s_guide", note: "New to Minecraft? Start here." },
];

// ── Render ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function cmdRows(cmds: Cmd[]): string {
  return cmds
    .map(
      (c) => `<tr><td><code>${esc(c.cmd)}</code></td><td>${esc(c.desc)}</td></tr>`,
    )
    .join("");
}

function page(username: string, isAdmin: boolean): string {
  const body = `
    <h1>Server Guide</h1>
    <p class="sub">Server address (if asked): <code>wss://minecraft.mncoleman.com</code></p>

    <h2>Welcome — how this server works</h2>
    <div class="card">
      <p style="margin:.1rem 0 .8rem">This isn't a normal Minecraft server — it runs in your browser and ties the game to your account here. Two things are different from anywhere else you've played, and getting them right makes everything else just work:</p>
      <ul style="margin:0;padding-left:1.2rem">
        <li style="margin:.45rem 0"><b>Set your in-game name to <code>${esc(username)}</code>.</b> Your worlds, builds and permissions are all stored against your account name. The first time you play, open <b>Edit Profile</b> on the title screen and set your username to exactly <code>${esc(username)}</code> (it's case-sensitive). If it doesn't match, the server kicks you with a reminder — that's the system protecting your stuff, not a bug.</li>
        <li style="margin:.45rem 0"><b>Keep this panel open in a second tab.</b> The game runs in its own tab with no menus for hopping worlds, teleporting, or sharing. Those controls live <em>here</em> — on the <a href="/worlds">Worlds</a> tab (press <code>W</code>). So play in one tab, and switch to this tab whenever you want to jump to a world, go to a friend, or manage access. Both tabs share the same login.</li>
      </ul>
      <p class="hint" style="margin:.8rem 0 0">New to Minecraft itself? The movement, commands and tips below cover the basics, and there are links to full references at the bottom.</p>
    </div>

    <h2>Movement &amp; basics</h2>
    <div class="card"><table>${cmdRows(BASICS)}</table></div>

    <h2>Operator commands ${isAdmin ? "" : '<span class="hint">(need operator/admin — shown for reference)</span>'}</h2>
    <div class="card"><table>${cmdRows(OP_CMDS)}</table></div>

    <h2>Tips</h2>
    <div class="card"><ul style="margin:0;padding-left:1.2rem">${TIPS.map((t) => `<li style="margin:.35rem 0">${esc(t)}</li>`).join("")}</ul></div>

    <h2>Resources</h2>
    <div class="card"><ul style="margin:0;padding-left:1.2rem">${LINKS.map(
      (l) => `<li style="margin:.4rem 0"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a> — <span class="hint">${esc(l.note)}</span></li>`,
    ).join("")}</ul></div>
  `;
  return shell({ title: "Guide", active: "guide", username, admin: isAdmin, body });
}

export function mountHelp(app: Hono): void {
  app.get("/help", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    return c.html(page(s.username, !!s.admin));
  });
}
