import type { Hono } from "hono";

// ── What's new feed ───────────────────────────────────────────────────────────
// One entry per release, newest first, in plain English for players. The Play
// page fetches /whats-new and renders these in the side panel. To announce a
// release, add an entry at the TOP — nothing else to touch.

export interface Release {
  date: string;   // YYYY-MM-DD (shown to players)
  title: string;  // short headline
  items: string[]; // bullet points, non-technical
}

export const CHANGELOG: Release[] = [
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

export function mountChangelog(app: Hono): void {
  // Public-ish JSON feed (still behind the session gate at the Caddy layer for
  // the play page; harmless if read directly). Cached briefly by the browser.
  app.get("/whats-new", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ releases: CHANGELOG });
  });
}
