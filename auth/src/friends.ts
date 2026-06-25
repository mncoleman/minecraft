import type { Hono, Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { db, type User } from "./db.ts";
import { config } from "./config.ts";
import { currentSession } from "./session.ts";
import { clientIp, rateLimited } from "./session.ts";
import { sendFriendRequest } from "./mailer.ts";
import { shell, esc } from "./layout.ts";

const now = () => Math.floor(Date.now() / 1000);
const REQUEST_TTL = 30 * 86400; // friend links/requests valid 30 days

// pair a friendship deterministically so (a,b) and (b,a) are the same row
function pair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function userById(id: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}
function userByUsername(name: string): User | null {
  return db.query("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(name) as User | null;
}

// ── friendship queries ────────────────────────────────────────────────────────
export function areFriends(a: string, b: string): boolean {
  const [x, y] = pair(a, b);
  return !!db.query("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?").get(x, y);
}
export function addFriendship(a: string, b: string): void {
  if (a === b) return;
  const [x, y] = pair(a, b);
  db.run("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?,?,?)", [x, y, now()]);
}
export function removeFriendship(a: string, b: string): void {
  const [x, y] = pair(a, b);
  db.run("DELETE FROM friendships WHERE user_a = ? AND user_b = ?", [x, y]);
}
export function listFriends(userId: string): Array<{ id: string; username: string; since: number }> {
  return db
    .query(
      `SELECT u.id, u.username,
              (CASE WHEN f.user_a = ?1 THEN f.created_at ELSE f.created_at END) AS since
         FROM friendships f
         JOIN users u ON u.id = (CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END)
        WHERE f.user_a = ?1 OR f.user_b = ?1
        ORDER BY u.username COLLATE NOCASE`,
    )
    .all(userId) as Array<{ id: string; username: string; since: number }>;
}
export function listFriendUsernames(userId: string): string[] {
  return listFriends(userId).map((f) => f.username);
}

/**
 * Lowercased usernames the given user may SEE in the "who's online" list:
 * themselves, their friends, and anyone they share a world with (co-owners and
 * co-members of any world they own or are a member of). Admins bypass this.
 */
export function visibleOnlineUsernames(userId: string): Set<string> {
  const set = new Set<string>();
  const me = userById(userId);
  if (me) set.add(me.username.toLowerCase());
  for (const u of listFriendUsernames(userId)) set.add(u.toLowerCase());
  const rows = db
    .query(
      `WITH my_worlds AS (
         SELECT id FROM worlds WHERE owner_user_id = ?1
         UNION
         SELECT w.id FROM worlds w JOIN world_shares s ON s.world_id = w.id WHERE s.grantee_user_id = ?1
       )
       SELECT DISTINCT u.username FROM (
         SELECT w.owner_user_id AS uid FROM worlds w JOIN my_worlds m ON m.id = w.id
         UNION
         SELECT s.grantee_user_id AS uid FROM world_shares s JOIN my_worlds m ON m.id = s.world_id
       ) x JOIN users u ON u.id = x.uid`,
    )
    .all(userId) as Array<{ username: string }>;
  for (const r of rows) set.add(r.username.toLowerCase());
  return set;
}

// ── friend requests ───────────────────────────────────────────────────────────
interface FriendRequest {
  id: string; code: string; from_user_id: string; to_user_id: string | null;
  status: string; created_at: number; expires_at: number | null;
}

function getRequestByCode(code: string): FriendRequest | null {
  return db.query("SELECT * FROM friend_requests WHERE code = ?").get(code) as FriendRequest | null;
}
function pendingBetween(fromId: string, toId: string): FriendRequest | null {
  return db
    .query("SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'")
    .get(fromId, toId) as FriendRequest | null;
}

/** Create (or reuse a still-valid) request. toUserId null = open friend link. */
export function createRequest(fromUserId: string, toUserId: string | null): string {
  if (toUserId) {
    const existing = pendingBetween(fromUserId, toUserId);
    if (existing) return existing.code;
  }
  const code = randomBytes(16).toString("hex");
  db.run(
    "INSERT INTO friend_requests (id, code, from_user_id, to_user_id, status, created_at, expires_at) VALUES (?,?,?,?, 'pending', ?, ?)",
    [randomUUID(), code, fromUserId, toUserId, now(), now() + REQUEST_TTL],
  );
  return code;
}

export function incomingRequests(userId: string): Array<{ id: string; code: string; from_username: string }> {
  return db
    .query(
      `SELECT r.id, r.code, u.username AS from_username
         FROM friend_requests r JOIN users u ON u.id = r.from_user_id
        WHERE r.to_user_id = ? AND r.status = 'pending'
        ORDER BY r.created_at DESC`,
    )
    .all(userId) as Array<{ id: string; code: string; from_username: string }>;
}
export function outgoingRequests(userId: string): Array<{ id: string; code: string; to_username: string | null }> {
  return db
    .query(
      `SELECT r.id, r.code, u.username AS to_username
         FROM friend_requests r LEFT JOIN users u ON u.id = r.to_user_id
        WHERE r.from_user_id = ? AND r.status = 'pending'
        ORDER BY r.created_at DESC`,
    )
    .all(userId) as Array<{ id: string; code: string; to_username: string | null }>;
}

// ── page ───────────────────────────────────────────────────────────────────────
function friendsPage(
  me: { sub: string; username: string; admin: boolean },
  newLink: string | null,
  msg?: string,
  err?: string,
): string {
  const friends = listFriends(me.sub);
  const incoming = incomingRequests(me.sub);
  const outgoing = outgoingRequests(me.sub);

  const incomingBlock = incoming.length
    ? incoming
        .map(
          (r) => `<div class="row" style="justify-content:space-between;margin:.3rem 0">
        <span><b>${esc(r.from_username)}</b> <span class="hint">wants to be friends</span></span>
        <span class="row" style="margin:0;gap:.4rem">
          <form method="post" action="/friends/j/${esc(r.code)}" style="margin:0"><button class="btn-primary">Accept</button></form>
          <form method="post" action="/friends/requests/${esc(r.id)}/decline" style="margin:0"><button class="btn-danger">Decline</button></form>
        </span></div>`,
        )
        .join("")
    : '<p class="hint">No friend requests right now.</p>';

  const friendRow = (f: { id: string; username: string }) =>
    `<div class="row" style="justify-content:space-between;margin:.3rem 0">
      <span><span class="dot"></span><b>${esc(f.username)}</b></span>
      <form method="post" action="/friends/remove" style="margin:0" onsubmit="return confirm('Remove ${esc(f.username)} from your friends?')">
        <input type="hidden" name="id" value="${esc(f.id)}"/><button class="btn-danger">Remove</button></form>
    </div>`;

  const outgoingBlock = outgoing.length
    ? `<div class="card"><div style="font-weight:600;margin-bottom:.5rem">Requests you've sent</div>${outgoing
        .map(
          (r) => `<div class="row" style="justify-content:space-between;margin:.3rem 0">
        <span class="hint">${r.to_username ? "to <b>" + esc(r.to_username) + "</b>" : "open friend link"} — waiting</span>
        <form method="post" action="/friends/requests/${esc(r.id)}/cancel" style="margin:0"><button class="btn-ghost">Cancel</button></form>
      </div>`,
        )
        .join("")}</div>`
    : "";

  const linkUrl = newLink ? `${config.publicBaseUrl}/friends/j/${newLink}` : null;

  const body = `
    <h1>Friends</h1>
    <p class="sub">Friends can see when each other are online and jump straight to one another from the <a href="/worlds">Worlds</a> tab. People who aren't your friends can't see when you're playing.</p>

    <div class="card">
      <p style="margin:.1rem 0 .2rem"><b>Two ways to add a friend:</b></p>
      <ul style="margin:.2rem 0 0;padding-left:1.2rem">
        <li style="margin:.3rem 0"><b>By username</b> — if you know their exact in-game name, send a request below. If they have an email on file, we'll email them a link too.</li>
        <li style="margin:.3rem 0"><b>Share a link</b> — create a friend link and send it to them however you like (text, chat, etc.). When they open it and click <b>Accept</b>, you're friends.</li>
      </ul>
    </div>

    <h2>Add by username</h2>
    <div class="card">
      <form method="post" action="/friends/request" class="row" style="margin:0">
        <input name="username" placeholder="their exact username" autocomplete="off" required/>
        <button class="btn-primary">Send request</button>
      </form>
    </div>

    <h2>Your friend link</h2>
    <div class="card">
      ${
        linkUrl
          ? `<p class="hint" style="margin:0 0 .5rem">Send this link to anyone you want to add. It works once they open it and click Accept.</p>
             <div class="row" style="margin:0">
               <input id="friendlink" readonly value="${esc(linkUrl)}" style="flex:1;font-family:ui-monospace,monospace;font-size:.85rem"/>
               <button class="btn-ghost" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('friendlink').value);this.textContent='Copied'">Copy</button>
             </div>`
          : `<p class="hint" style="margin:0 0 .5rem">Create a link you can share with anyone. They'll become your friend when they open it and accept.</p>
             <form method="post" action="/friends/link" style="margin:0"><button class="btn-primary">Create a friend link</button></form>`
      }
    </div>

    <h2>Friend requests</h2>
    <div class="card">${incomingBlock}</div>

    ${outgoingBlock}

    <h2>Your friends</h2>
    ${friends.length ? `<div class="card">${friends.map(friendRow).join("")}</div>` : '<p class="hint">No friends yet — add one above.</p>'}
  `;
  return shell({ title: "Friends", active: "friends", username: me.username, admin: me.admin, body, msg, err });
}

// Shown when a logged-OUT visitor opens a friend link. Login redirects to "/",
// so rather than bounce them and lose the link, we explain and let them log in
// then re-open the same link (it stays valid for 30 days).
function loginToAcceptPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Friend request · minecraft.mncoleman.com</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;color:#e8eaed;background:radial-gradient(1200px 600px at 50% -10%,#1c2a22,transparent 60%),#0d0f12;padding:1.5rem}
.card{width:100%;max-width:400px;background:#14171d;border:1px solid #232a35;border-radius:16px;padding:1.75rem;text-align:center}
h1{font-size:1.3rem;margin:0 0 .6rem}p{color:#9aa4b2;margin:0 0 1.2rem}
a.btn{display:inline-block;padding:.75rem 1.2rem;border-radius:10px;border:1px solid #357a57;background:#2f6f4f;color:#fff;font-weight:700;text-decoration:none}
.hint{font-size:.85rem;margin-top:1rem}</style></head><body>
<div class="card">
  <h1>⛏ Someone wants to be your friend</h1>
  <p>Log in to your Minecraft account to accept, then open this link again.</p>
  <a class="btn" href="/login">Log in</a>
  <p class="hint">This link stays valid for 30 days, so you can come back to it anytime.</p>
</div></body></html>`;
}

// who-invited confirm card shown when someone opens a friend link / email link
function confirmPage(me: { username: string; admin: boolean }, fromUsername: string, code: string): string {
  const body = `
    <h1>Friend request</h1>
    <div class="card">
      <p style="margin:.1rem 0 .8rem"><b>${esc(fromUsername)}</b> would like to be your friend. If you accept, you'll both be able to see when the other is online and jump to each other in the game.</p>
      <div class="row" style="margin:0;gap:.5rem">
        <form method="post" action="/friends/j/${esc(code)}" style="margin:0"><button class="btn-primary">Accept</button></form>
        <a class="pill" href="/friends">Not now</a>
      </div>
    </div>`;
  return shell({ title: "Friend request", active: "friends", username: me.username, admin: me.admin, body });
}

// ── routes ─────────────────────────────────────────────────────────────────────
async function me(c: Context) {
  const s = await currentSession(c);
  if (!s) return null;
  return { sub: s.sub, username: s.username, admin: !!s.admin };
}

export function mountFriends(app: Hono): void {
  app.get("/friends", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    return c.html(friendsPage(m, c.req.query("newlink") ?? null, c.req.query("msg"), c.req.query("err")));
  });

  // Send a request to a known username (and email them if possible).
  app.post("/friends/request", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    if (rateLimited("friendreq:" + clientIp(c))) {
      return c.redirect("/friends?err=" + encodeURIComponent("Too many requests — wait a few minutes."));
    }
    const form = await c.req.parseBody();
    const target = userByUsername(String(form.username ?? "").trim());
    if (!target) return c.redirect("/friends?err=" + encodeURIComponent("No player with that exact username."));
    if (target.id === m.sub) return c.redirect("/friends?err=" + encodeURIComponent("You can't friend yourself."));
    if (areFriends(m.sub, target.id)) return c.redirect("/friends?msg=" + encodeURIComponent(`You're already friends with ${target.username}.`));
    const code = createRequest(m.sub, target.id);
    const link = `${config.publicBaseUrl}/friends/j/${code}`;
    let emailed = "";
    if (target.email) {
      const res = await sendFriendRequest(target.email, link, m.username);
      emailed = res.ok ? ` We emailed ${target.username} a link too.` : "";
    }
    return c.redirect("/friends?msg=" + encodeURIComponent(`Friend request sent to ${target.username}. They'll see it in their Friends tab.${emailed}`));
  });

  // Create an open friend link to share.
  app.post("/friends/link", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const code = createRequest(m.sub, null);
    return c.redirect("/friends?newlink=" + encodeURIComponent(code));
  });

  // Open a friend link / emailed request: show a confirm card.
  app.get("/friends/j/:code", async (c) => {
    const m = await me(c);
    if (!m) return c.html(loginToAcceptPage());
    const r = getRequestByCode(c.req.param("code"));
    if (!r || r.status !== "pending" || (r.expires_at && now() > r.expires_at)) {
      return c.redirect("/friends?err=" + encodeURIComponent("That friend link is invalid, used, or expired."));
    }
    if (r.from_user_id === m.sub) return c.redirect("/friends?err=" + encodeURIComponent("That's your own friend link — share it with someone else."));
    if (r.to_user_id && r.to_user_id !== m.sub) return c.redirect("/friends?err=" + encodeURIComponent("That request was meant for a different account."));
    if (areFriends(m.sub, r.from_user_id)) {
      db.run("UPDATE friend_requests SET status='accepted' WHERE id = ?", [r.id]);
      const from = userById(r.from_user_id);
      return c.redirect("/friends?msg=" + encodeURIComponent(`You're already friends with ${from?.username ?? "them"}.`));
    }
    const from = userById(r.from_user_id);
    return c.html(confirmPage(m, from?.username ?? "Someone", r.code));
  });

  // Accept a friend link / request.
  app.post("/friends/j/:code", async (c) => {
    const m = await me(c);
    if (!m) return c.html(loginToAcceptPage());
    const r = getRequestByCode(c.req.param("code"));
    if (!r || r.status !== "pending" || (r.expires_at && now() > r.expires_at)) {
      return c.redirect("/friends?err=" + encodeURIComponent("That friend link is invalid, used, or expired."));
    }
    if (r.from_user_id === m.sub) return c.redirect("/friends?err=" + encodeURIComponent("That's your own friend link."));
    if (r.to_user_id && r.to_user_id !== m.sub) return c.redirect("/friends?err=" + encodeURIComponent("That request was meant for a different account."));
    addFriendship(m.sub, r.from_user_id);
    // Open links stay reusable; targeted requests are one-shot.
    if (r.to_user_id) db.run("UPDATE friend_requests SET status='accepted' WHERE id = ?", [r.id]);
    const from = userById(r.from_user_id);
    return c.redirect("/friends?msg=" + encodeURIComponent(`You're now friends with ${from?.username ?? "them"}.`));
  });

  // Decline an incoming request.
  app.post("/friends/requests/:id/decline", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    db.run("UPDATE friend_requests SET status='declined' WHERE id = ? AND to_user_id = ? AND status='pending'", [c.req.param("id"), m.sub]);
    return c.redirect("/friends?msg=" + encodeURIComponent("Request declined."));
  });

  // Cancel a request you sent (or your open link).
  app.post("/friends/requests/:id/cancel", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    db.run("UPDATE friend_requests SET status='revoked' WHERE id = ? AND from_user_id = ? AND status='pending'", [c.req.param("id"), m.sub]);
    return c.redirect("/friends?msg=" + encodeURIComponent("Request cancelled."));
  });

  // Remove a friend.
  app.post("/friends/remove", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const form = await c.req.parseBody();
    const other = userById(String(form.id ?? ""));
    if (!other) return c.redirect("/friends?err=" + encodeURIComponent("User not found."));
    removeFriendship(m.sub, other.id);
    return c.redirect("/friends?msg=" + encodeURIComponent(`Removed ${other.username}.`));
  });
}
