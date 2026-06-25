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
    title: "Make your own worlds + add friends",
    items: [
      "You can now create your own world from the Worlds tab — your own private space that saves automatically as you build.",
      "New Friends tab: add friends by username, or share a friend link. Friends can see when each other are online and jump straight to one another.",
      "“Who's online” now only shows your friends and people you share a world with, so your playing time stays private.",
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
