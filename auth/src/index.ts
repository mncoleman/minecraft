import { Hono } from "hono";
import type { Context, Next } from "hono";
import { stat } from "node:fs/promises";
import { config, providersEnabled } from "./config.ts";
import { currentSession, clearSessionCookie } from "./session.ts";
import { bootstrapAllowlist } from "./db.ts";
import { mountTelegram } from "./providers/telegram.ts";
import { mountGoogle } from "./providers/google.ts";
import { mountEmail } from "./providers/email.ts";
import { mountAdmin } from "./admin.ts";
import { mountHelp } from "./help.ts";
import { mountWorlds } from "./worlds_admin.ts";
import { mountInvites } from "./invites.ts";
import { mountProfile } from "./profile.ts";
import { reconcile, bootstrapWorlds } from "./worlds.ts";
import { startHopAutoRoute, startLocationLogger } from "./presence.ts";

bootstrapAllowlist();

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

// ── forward_auth endpoint for Caddy ──────────────────────────────────────────
// 200 → Caddy serves the client (and passes X-Mc-User). 401 → Caddy redirects
// to /login. NOTE: this gate is UX only; the real boundary is the in-game JWT
// plugin, because the wss:// socket is reachable independently of this page.
app.get("/auth/verify", async (c) => {
  const s = await currentSession(c);
  if (!s) return c.text("unauthorized", 401);
  c.header("X-Mc-User", s.username);
  c.header("X-Mc-Admin", s.admin ? "1" : "0");
  return c.text("ok", 200);
});

// ── login page ───────────────────────────────────────────────────────────────
app.get("/login", async (c) => {
  if (await currentSession(c)) return c.redirect("/");
  const file = Bun.file(new URL("../public/login.html", import.meta.url).pathname);
  let page = await file.text();
  const injected = `<script>window.MC_AUTH=${JSON.stringify({
    providers: providersEnabled(),
    telegramBot: config.telegram.botUsername,
    error: c.req.query("error") ?? null,
  })}</script>`;
  page = page.replace("</head>", `${injected}\n</head>`);
  return c.html(page);
});

// POST-only: a GET /logout could be triggered cross-site (e.g. <img src>) to
// force-log-out a user. The nav uses a POST form.
app.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.redirect("/login");
});

mountTelegram(app);
mountGoogle(app);
mountEmail(app);
mountAdmin(app);
mountHelp(app);
mountWorlds(app);
mountInvites(app);
mountProfile(app);

// Boot reconciler: seed + re-push all world access grants so the live server
// self-heals. Retries a few times in case RCON isn't warm yet on cold boot.
(async () => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 12000 : 20000));
    try {
      bootstrapWorlds();
      const r = await reconcile();
      console.log(`reconcile ok (attempt ${attempt}): ${r.worlds} worlds, ${r.grants} grants`);
      return;
    } catch (e: any) {
      console.error(`reconcile attempt ${attempt} failed:`, e?.message || e);
    }
  }
})();

// Offline hop auto-route: drop queued players into their world when they join.
startHopAutoRoute();

// Location logger: record online players' positions for the command center.
startLocationLogger();

// Periodic reconcile (self-heal from any drift) every 15 minutes.
setInterval(() => {
  reconcile()
    .then((r) => console.log(`periodic reconcile: ${r.worlds} worlds, ${r.grants} grants`))
    .catch((e) => console.error("periodic reconcile failed:", e?.message || e));
}, 15 * 60 * 1000);

// ── static Eaglercraft client ────────────────────────────────────────────────
// Served from a mounted volume so Caddy never needs filesystem access (all Caddy
// routes stay reverse_proxy, like the other sites). CLIENTS_DIR is the mount.
const CLIENTS = (process.env.CLIENTS_DIR || "/clients").replace(/\/+$/, "");

// Gate the client behind a valid session: unauthenticated visitors get bounced
// to /login and can't even load the client. (The in-game plugin is still the
// hard boundary for the multiplayer socket — this is the front-door UX + DiD.)
const gate = async (c: Context, next: Next) => {
  if (!(await currentSession(c))) return c.redirect("/login");
  return next();
};

// Static client served with a weak ETag (size+mtime). The ~15MB WASM client
// otherwise re-downloads in full on every visit (serveStatic emitted no
// validators); with revalidation the browser gets a tiny 304 when unchanged,
// yet still picks up a fresh client immediately after a redeploy (max-age=0).
const serveClient = async (c: Context): Promise<Response> => {
  let rel = c.req.path;
  if (rel.endsWith("/")) rel += "index.html";
  rel = rel.replace(/\.\.+/g, ""); // defense-in-depth: no path traversal
  const full = CLIENTS + rel;
  const f = Bun.file(full);
  if (!(await f.exists())) return c.text("not found", 404);
  let etag: string;
  try {
    const s = await stat(full);
    etag = `W/"${s.size}-${Math.trunc(s.mtimeMs)}"`;
  } catch {
    return c.text("not found", 404);
  }
  const cacheCtl = "public, max-age=0, must-revalidate";
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheCtl } });
  }
  return new Response(f, {
    headers: { "Content-Type": f.type || "application/octet-stream", ETag: etag, "Cache-Control": cacheCtl },
  });
};

// root-based serving: req "/" -> {CLIENTS}/index.html (index default), etc.
app.get("/", gate, serveClient);
app.get("/index.html", gate, serveClient);
app.get("/wasm/*", gate, serveClient);
app.get("/js/*", gate, serveClient);

console.log(`mc-auth listening on :${config.port} (base ${config.publicBaseUrl})`);
console.log("providers:", providersEnabled());

export default { port: config.port, fetch: app.fetch };
