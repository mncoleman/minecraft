import type { Hono } from "hono";
import { currentSession } from "./session.ts";
import { getPresence } from "./presence.ts";
import { enabledServers, serverLabel, type ServerId } from "./servers.ts";
import { listAllWorlds, listWorldsOwnedBy, isLobby } from "./worlds.ts";
import { visibleOnlineUsernames } from "./friends.ts";
import { config } from "./config.ts";
import { shell, esc, icon, pageHead, tiles, panel, edBadge, type Tile } from "./layout.ts";

// ── What's new feed ───────────────────────────────────────────────────────────
// One entry per release, newest first, in plain English for players. The Home
// page (/) renders these in a fixed-height scroll box; /whats-new serves the same
// list as JSON. To announce a release, add an entry at the TOP — nothing else.

export interface Release {
  date: string;   // YYYY-MM-DD (shown to players)
  title: string;  // short headline
  items: string[]; // bullet points, non-technical
}

export const CHANGELOG: Release[] = [
  {
    date: "2026-11-16",
    title: "A new look: the panel is a dashboard now",
    items: [
      "Every page has a sidebar menu (a top bar on phones), live numbers at the top, and the 1.8 and 26 servers side by side so you can see which world lives where.",
      "Home shows how many people are on each server, your worlds, and both Play buttons in one place.",
      "This What's new list now sits in its own scroll box. Hit \"See older updates\" to read further back.",
      "Keyboard shortcuts still work: W Worlds, F Friends, C Claude, G Guide, B Feedback, P Profile, and Y to play.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Claude is open to every player",
    items: [
      "Anyone can now connect Claude from the Claude tab. Add it in claude.ai under Settings → Connectors, sign in here, and ask it to build.",
      "Claude acts as you: it can build in the same worlds you can, and it only sees where your friends are, not everyone.",
      "Raw server commands stay with the server owner.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Minecraft 26 is back, right beside 1.8",
    items: [
      "There are two servers again: the classic 1.8 one and modern Minecraft 26. Home has a Play button for each.",
      "Every world lives on one server and stays there. The Worlds page shows each server's worlds in its own column.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Every world is open to everyone",
    items: [
      "Every player can visit and build in every world on both servers, and use the Command page of any world except the Shared World.",
      "The lobby is now called the Shared World.",
      "Anyone can upload a world they built in singleplayer (it goes to the 1.8 server).",
      "The Claude page now leads with the claude.ai connector, the easiest way to hook Claude up.",
    ],
  },
  {
    date: "2026-11-11",
    title: "Claude can build with you (admin preview)",
    items: [
      "Admins can now connect Claude (the AI) from the new Claude tab and ask it to build things — like \"an underground cart line from the village to the castle\".",
      "Claude plans the whole thing first (route, tunnels, bridges, powered rails, stations) and shows a preview before it builds. Every build can be undone.",
      "While Claude builds, a player called Claude with a gold helmet appears next to the work.",
      "It only builds where the person asking is allowed to build. It's admin-only while we try it out.",
    ],
  },
  {
    date: "2026-11-11",
    title: "The lobby is on the Worlds page",
    items: [
      "The shared lobby now shows at the top of the Worlds tab with Notes and Hop in. Everyone can still build there, same as before.",
      "Command Center: changing your game mode or giving yourself items now only works while you're standing in that world.",
    ],
  },
  {
    date: "2026-06-25",
    title: "Run commands in your own world",
    items: [
      "If you own a world, you can now use game commands like /gamemode, /give, /time, /weather, /gamerule and /difficulty while you are playing in it.",
      "These only work in worlds you own, not in the shared lobby or in other people's worlds.",
    ],
  },
  {
    date: "2026-06-25",
    title: "Clearer Guide and a new FAQ",
    items: [
      "The Guide now explains what this version of Minecraft (1.8) includes and what it does not, so things like crossbows not existing are no longer a mystery.",
      "Added a short FAQ covering the questions new players ask most, and reworded help text into plainer, friendlier language.",
    ],
  },
  {
    date: "2026-06-25",
    title: "Now works on phones",
    items: [
      "The panel is mobile-friendly now: the top menu no longer overlaps itself, and admin lists reflow into tidy, readable cards on a small screen.",
    ],
  },
  {
    date: "2026-06-25",
    title: "Make your own worlds + add friends",
    items: [
      "You can now create your own world from the Worlds tab — your own private space that saves automatically as you build.",
      "New Friends tab: add friends by username, or share a friend link. Friends can see when each other are online and jump straight to one another.",
      "“Who's online” now only shows your friends and people you share a world with, so your playing time stays private.",
      "Sharing a world is now a pick-from-a-list: choose a friend (or any player, if you're an admin) instead of typing their name.",
      "Plain-English help added throughout the panel explaining worlds, the lobby, and sharing.",
    ],
  },
];

// How many releases show before "See older updates".
const FEED_FIRST = 4;

function feedHtml(): string {
  const rels = CHANGELOG.map((rel, i) => `<div class="rel${i >= FEED_FIRST ? " old" : ""}">
    <div class="when">${esc(rel.date)}</div><div class="title">${esc(rel.title)}</div>
    <ul>${rel.items.map((it) => `<li>${esc(it)}</li>`).join("")}</ul></div>`).join("");
  const older = Math.max(0, CHANGELOG.length - FEED_FIRST);
  return `<div class="feed" id="feed">${rels}</div>
    ${older ? `<button type="button" class="feed-more" id="feed-more" aria-expanded="false" aria-controls="feed">See older updates (${older})</button>
    <script>(function(){var f=document.getElementById("feed"),b=document.getElementById("feed-more");if(!f||!b)return;
      b.addEventListener("click",function(){var o=f.classList.toggle("open");b.setAttribute("aria-expanded",o?"true":"false");
      b.textContent=o?"Show less":"See older updates (${older})";if(!o)f.scrollTop=0;});})();</script>` : ""}`;
}

const SRV_NOTE: Record<ServerId, string> = { "18": "Classic 1.8 · Paper 1.12.2", "26": "Modern Minecraft 26 · Paper 26.2" };

// ── Home (/) ──────────────────────────────────────────────────────────────────
// The Play page, server-rendered through shell() (it used to be the static
// clients/index.html). Game clients under /wasm, /js and /26 are untouched.
async function homePage(me: { sub: string; username: string; admin: boolean }): Promise<string> {
  const servers = enabledServers();
  const on = new Set(servers);
  const onlineAll = await getPresence();
  const onCount = (s: ServerId) => onlineAll.filter((p) => p.server === s).length;
  const worlds = listAllWorlds().filter((w) => w.status === "active" && on.has(w.server));
  const worldsOn = (s: ServerId) => worlds.filter((w) => w.server === s).length;
  const mine = listWorldsOwnedBy(me.sub).filter((w) => w.status === "active" && on.has(w.server) && !isLobby(w.mv_world_name));
  const vis = me.admin ? null : visibleOnlineUsernames(me.sub);
  const meLc = me.username.toLowerCase();
  const friendsOn = onlineAll.filter((p) => p.name.toLowerCase() !== meLc && (!vis || vis.has(p.name.toLowerCase())));
  const here = onlineAll.find((p) => p.name.toLowerCase() === meLc)?.server ?? null;
  const host = config.publicBaseUrl.replace(/^https?:\/\//, "");
  const has26 = on.has("26");

  const launch = (s: ServerId) => {
    const n = onCount(s);
    const play = s === "18"
      ? `<a class="launch" id="play-primary" href="js/" target="_blank" rel="noopener" title="Shortcut: Y (opens the game in a new tab)">${icon("play")} Play ${has26 ? "1.8" : ""}</a>
         <p class="hint" id="alt-line" style="margin:.6rem 0 0;text-align:center"></p>`
      : `<a class="launch l26" id="play-26" href="/26" target="_blank" rel="noopener" title="Opens Minecraft 26 in a new tab">${icon("play")} Play 26</a>
         <p class="hint" style="margin:.6rem 0 0;text-align:center">Chrome or Firefox on a computer.</p>`;
    return `<section class="srv srv-${s}">
      <div class="srv-h"><div><div class="name">${icon("server")} Minecraft ${serverLabel(s)}</div><div class="ver">${SRV_NOTE[s]}</div></div>
        <span class="chip${n ? " live" : ""}">${n ? '<span class="dot on"></span>' : ""}${n} online</span></div>
      <div class="srv-b">${play}
        <div class="sect">Server address <span style="text-transform:none;letter-spacing:0">(only if it ever asks)</span></div>
        <code data-copy title="Click to copy">wss://${esc(host)}/${s === "26" ? "26" : ""}</code>
        ${here === s ? `<p class="hint" style="margin:.7rem 0 0"><span class="dot on"></span>You're on this server right now.</p>` : ""}
      </div></section>`;
  };

  const body = `
    ${pageHead({
      eyebrow: "Command center",
      title: `Hi, ${esc(me.username)}`,
      sub: "Pick a server and hit Play. Your worlds, friends and Claude are one key away.",
      actions: `<a class="pill" href="/worlds">${icon("globe")} Worlds</a><a class="pill" href="/claude">${icon("sparkles")} Claude</a>`,
    })}
    ${tiles([
      ...servers.map((s): Tile => ({ k: `Online · ${serverLabel(s)}`, v: onCount(s), f: `${worldsOn(s)} worlds on ${serverLabel(s)}`, tone: s, icon: "activity" })),
      { k: "Friends online", v: friendsOn.length, f: friendsOn.length ? friendsOn.slice(0, 3).map((p) => esc(p.name)).join(", ") + (friendsOn.length > 3 ? "…" : "") : `<a href="/friends">Add friends →</a>`, icon: "users" },
      { k: "Your worlds", v: mine.length, f: mine.length ? mine.slice(0, 3).map((w) => esc(w.name)).join(", ") : `<a href="/worlds#create">Create one →</a>`, tone: "acc", icon: "globe" },
    ])}
    <div class="cols-3">
      <div>
        <div class="split" style="margin-top:0">${servers.map(launch).join("")}</div>
        ${panel(`${icon("book")} How it works`, `<ol style="margin:0;padding-left:1.2rem;line-height:1.75">
          <li>Click <b>Play</b>: you connect to that server automatically (no menus). Each server has its own worlds.</li>
          <li><b>First time only:</b> on the title screen, open <b>Edit Profile</b> and set your name to <b>${esc(me.username)}</b> so it matches your account.</li>
          <li>Use <a href="/worlds">Worlds</a> to <b>Hop in</b> to a world or <b>Join</b> a friend who's online.</li>
          <li>Want help building? Connect <a href="/claude">Claude</a> and ask for a castle, a cart line, anything.</li>
        </ol><p class="hint" style="margin:.7rem 0 0">New here? Read the <a href="/help">guide →</a></p>`)}
      </div>
      <div>${panel(`${icon("megaphone")} What's new`, feedHtml(), `<span class="hint" style="font-size:.78rem">${CHANGELOG.length} updates</span>`)}</div>
    </div>
    <script>(function(){
      // 1.8 client choice: the WASM build is fastest where JSPI exists; iOS/Safari get the JS build.
      var ua=navigator.userAgent,isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1),
          isSafari=/^((?!chrome|android|crios|fxios).)*safari/i.test(ua),
          hasJSPI=(typeof WebAssembly!=="undefined")&&("Suspending" in WebAssembly),useWasm=hasJSPI&&!isIOS&&!isSafari;
      var p=document.getElementById("play-primary"),alt=document.getElementById("alt-line");if(!p)return;
      if(useWasm){p.href="wasm/";p.insertAdjacentHTML("beforeend",' <span class="rec">fastest</span>');
        alt.innerHTML='On an iPhone, iPad, or Safari? <a href="js/" target="_blank" rel="noopener">Play here instead →</a>';}
      else{p.href="js/";alt.innerHTML='On a computer with Chrome or Firefox? <a href="wasm/" target="_blank" rel="noopener">Play the faster version →</a>';}
    })();</script>`;
  // On Home, Y launches the 1.8 game instead of navigating to Home.
  return shell({ title: "Home", active: "play", username: me.username, admin: me.admin, body, keys: { y: "#play-primary" } });
}

export function mountChangelog(app: Hono): void {
  app.get("/", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    c.header("Cache-Control", "no-store");
    return c.html(await homePage({ sub: s.sub, username: s.username, admin: !!s.admin }));
  });

  // Public-ish JSON feed (still behind the session gate at the Caddy layer for
  // the play page; harmless if read directly). Cached briefly by the browser.
  app.get("/whats-new", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ releases: CHANGELOG });
  });
}
