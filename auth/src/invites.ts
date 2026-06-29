import type { Hono, Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { db, addAllow, resolveEmailLogin, sanitizeUsername, createToken, getUserById, deleteUser, renameUser } from "./db.ts";
import { config } from "./config.ts";
import { currentSession } from "./session.ts";
import { signSession } from "./jwt.ts";
import { setSessionCookie, clientIp, rateLimited } from "./session.ts";
import { sendInvite, sendVerifyEmail } from "./mailer.ts";
import { listWorldsSharedWith, listWorldsOwnedBy, revokeBuild, transferInGameIdentity } from "./worlds.ts";
import { rcon } from "./rcon.ts";
import { icon } from "./layout.ts";

const now = () => Math.floor(Date.now() / 1000);
const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

export interface Invite {
  id: string; code: string; email: string | null; suggested_username: string | null;
  role: string; invited_by: string; status: string; accepted_user_id: string | null;
  created_at: number; accepted_at: number | null; expires_at: number | null;
}

export interface InviteRow extends Invite {
  inviter: string | null;
  accepted_username: string | null;
  accepted_email: string | null;
}
export function listInvites(): InviteRow[] {
  return db.query(
    `SELECT i.*,
            u.username  AS inviter,
            au.username AS accepted_username,
            au.email    AS accepted_email
       FROM invites i
       LEFT JOIN users u  ON u.id  = i.invited_by
       LEFT JOIN users au ON au.id = i.accepted_user_id
      ORDER BY i.created_at DESC`,
  ).all() as InviteRow[];
}
function getByCode(code: string): Invite | null {
  return db.query("SELECT * FROM invites WHERE code = ?").get(code) as Invite | null;
}

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function signupPage(code: string, inv: Invite, error?: string): string {
  const emailField = inv.email
    ? `<input type="email" name="email" value="${esc(inv.email)}" readonly />`
    : `<input type="email" name="email" placeholder="your email" required />`;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/email-logo.png"/>
<title>Join · minecraft.mncoleman.com</title>
<style>
 :root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;color:#e8eaed;background:radial-gradient(1200px 600px at 50% -10%,#1c2a22,transparent 60%),#0d0f12;padding:1.5rem}
 .card{width:100%;max-width:380px;background:#14171d;border:1px solid #232a35;border-radius:16px;padding:1.75rem}
 h1{font-size:1.4rem;margin:0 0 .2rem}.sub{color:#8b95a3;margin:0 0 1.3rem;font-size:.92rem}
 form{display:grid;gap:.6rem}input{padding:.7rem .85rem;border-radius:10px;border:1px solid #2c333f;background:#0f1217;color:#e8eaed;font:inherit}
 button{padding:.75rem;border-radius:10px;border:1px solid #357a57;background:#2f6f4f;color:#fff;font:inherit;font-weight:700;cursor:pointer}
 .err{background:#3a1d24;border:1px solid #6b2c39;color:#ffb3c0;padding:.55rem .8rem;border-radius:10px;font-size:.88rem;margin-bottom:.8rem}
 .hint{color:#8b95a3;font-size:.82rem;margin-top:1rem;text-align:center}
 .ic{vertical-align:-.13em}
</style></head><body><div class="card">
 <h1>${icon("pickaxe")} Join the server</h1>
 <p class="sub">You've been invited to minecraft.mncoleman.com. Pick your in-game name and a password.</p>
 ${error ? `<div class="err">${esc(error)}</div>` : ""}
 <form method="post" action="/invite/${esc(code)}">
   ${emailField}
   <input name="username" value="${esc(inv.suggested_username || "")}" placeholder="in-game username (3-16, letters/numbers/_)" required />
   <input type="password" name="password" placeholder="password (min 12 chars)" minlength="12" required />
   <button type="submit">Create my account</button>
 </form>
 <p class="hint">Your in-game name will be locked to this account.</p>
</div></body></html>`;
}

async function requireAdmin(c: Context): Promise<{ sub: string; admin: boolean; email?: string } | null> {
  const s = await currentSession(c);
  return s?.admin ? { sub: s.sub, admin: true } : null;
}
function isOwner(c: Context): Promise<boolean> {
  return currentSession(c).then((s) => {
    if (!s) return false;
    const u = db.query("SELECT email FROM users WHERE id = ?").get(s.sub) as { email: string | null } | null;
    return !!u?.email && u.email.toLowerCase() === OWNER_EMAIL;
  });
}

export function mountInvites(app: Hono): void {
  // Create an invite (admin/owner). role='admin' only if the creator is the owner.
  app.post("/admin/invites", async (c) => {
    const adm = await requireAdmin(c);
    if (!adm) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const form = await c.req.parseBody();
    const email = String(form.email ?? "").trim().toLowerCase() || null;
    const suggested = sanitizeUsername(String(form.suggested_username ?? "")) || null;
    let role = String(form.role ?? "user");
    if (role === "admin" && !(await isOwner(c))) role = "user"; // only owner can mint admin invites
    const code = randomBytes(16).toString("hex");
    db.run(
      "INSERT INTO invites (id,code,email,suggested_username,role,invited_by,status,created_at,expires_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?)",
      [randomUUID(), code, email, suggested, role, adm.sub, now(), now() + 14 * 86400],
    );
    const link = `${config.publicBaseUrl}/invite/${code}`;

    // Optionally email the link straight to the invitee (only if an email was given).
    if (email && String(form.send_email ?? "") === "1") {
      const inviter = (db.query("SELECT username FROM users WHERE id = ?").get(adm.sub) as { username: string } | null)?.username;
      const res = await sendInvite(email, link, { inviter, role });
      const where = res.ok ? "Invite emailed to " + email + ". " : "Could not email it (" + (res.error ?? "error") + "); share the link manually. ";
      return c.redirect("/admin?msg=" + encodeURIComponent(where + "Link (valid 14 days): " + link));
    }
    return c.redirect("/admin?msg=" + encodeURIComponent("Invite link (valid 14 days): " + link));
  });

  app.post("/admin/invites/:code/revoke", async (c) => {
    if (!(await requireAdmin(c))) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    db.run("UPDATE invites SET status='revoked' WHERE code = ? AND status='pending'", [c.req.param("code")]);
    return c.redirect("/admin?msg=" + encodeURIComponent("Invite revoked."));
  });

  // Owner-only role change.
  app.post("/admin/users/:id/role", async (c) => {
    if (!(await isOwner(c))) return c.redirect("/admin?err=" + encodeURIComponent("Owner only."));
    const form = await c.req.parseBody();
    const makeAdmin = String(form.is_admin ?? "") === "1";
    const target = db.query("SELECT email FROM users WHERE id = ?").get(c.req.param("id")) as { email: string | null } | null;
    if (target?.email && target.email.toLowerCase() === OWNER_EMAIL) {
      return c.redirect("/admin?err=" + encodeURIComponent("Cannot change the owner's role."));
    }
    db.run("UPDATE users SET is_admin = ? WHERE id = ?", [makeAdmin ? 1 : 0, c.req.param("id")]);
    return c.redirect("/admin?msg=" + encodeURIComponent(makeAdmin ? "Promoted to admin." : "Demoted to user."));
  });

  // Rename a user (admin-only). The target keeps their worlds, shares and builds;
  // in-game access is re-granted under the new offline UUID. The target's browser
  // cookie isn't rotated, but the in-game plugin resolves the CURRENT username
  // from the JWT's stable account id, so the rename takes effect in-game without a
  // re-login. The owner is never renamable (in-game op is keyed by name).
  app.post("/admin/users/:id/username", async (c) => {
    const adm = await requireAdmin(c);
    if (!adm) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const target = getUserById(c.req.param("id"));
    if (!target) return c.redirect("/admin?err=" + encodeURIComponent("User not found."));
    if ((target.email || "").toLowerCase() === OWNER_EMAIL) {
      return c.redirect("/admin?err=" + encodeURIComponent("The owner username can't be changed."));
    }
    const form = await c.req.parseBody();
    const result = renameUser(target.id, String(form.username ?? ""));
    if ("error" in result) return c.redirect("/admin?err=" + encodeURIComponent(result.error));
    await transferInGameIdentity(target.id, result.oldUsername, result.newUsername);
    return c.redirect("/admin?msg=" + encodeURIComponent(
      `Renamed ${result.oldUsername} to ${result.newUsername}. They just set their new name in Edit Profile in-game and reconnect — no sign-out needed.`));
  });

  // Delete a user (admin-only). Guards: never the owner, never yourself, and a
  // plain admin can't delete another admin (only the owner can). The account
  // must own no worlds (those are irreplaceable — reassign/delete them first).
  app.post("/admin/users/:id/delete", async (c) => {
    const adm = await requireAdmin(c);
    if (!adm) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const targetId = c.req.param("id");
    if (targetId === adm.sub) return c.redirect("/admin?err=" + encodeURIComponent("You can't delete your own account."));
    const target = getUserById(targetId);
    if (!target) return c.redirect("/admin?err=" + encodeURIComponent("User not found."));
    if ((target.email || "").toLowerCase() === OWNER_EMAIL) return c.redirect("/admin?err=" + encodeURIComponent("The owner account can't be deleted."));
    if (target.is_admin && !(await isOwner(c))) return c.redirect("/admin?err=" + encodeURIComponent("Only the owner can delete an admin."));
    const ownedWorlds = listWorldsOwnedBy(targetId);
    if (ownedWorlds.length > 0) {
      const names = ownedWorlds.map((w) => w.name).join(", ");
      return c.redirect("/admin?err=" + encodeURIComponent(
        `${target.username} still owns ${ownedWorlds.length} world(s): ${names}. Reassign them to another user under "All worlds" below, then delete.`));
    }

    // Capture their build grants before deletion so we can revoke them in-game.
    const shared = listWorldsSharedWith(targetId);
    const res = deleteUser(targetId);
    if (!res) return c.redirect("/admin?err=" + encodeURIComponent("User not found."));
    for (const w of shared) { try { await revokeBuild(res.username, w.mv_world_name); } catch { /* best-effort */ } }
    // Boot them from the game now if they're online — their session JWT stays
    // valid until expiry, but currentSession() + the in-game plugin now reject a
    // deleted account, so they can't reconnect either.
    await rcon(`kick ${res.username} Your account was removed`).catch(() => {});
    return c.redirect("/admin?msg=" + encodeURIComponent(`Deleted ${res.username} and revoked their access.`));
  });

  // Public signup via invite link.
  app.get("/invite/:code", (c) => {
    const inv = getByCode(c.req.param("code"));
    if (!inv || inv.status !== "pending" || (inv.expires_at && now() > inv.expires_at)) {
      return c.html(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0d0f12;color:#e8eaed;display:grid;place-items:center;height:100vh"><div>This invite link is invalid, used, or expired.</div></body>`, 410);
    }
    return c.html(signupPage(c.req.param("code"), inv));
  });

  app.post("/invite/:code", async (c) => {
    const code = c.req.param("code");
    const inv = getByCode(code);
    if (!inv || inv.status !== "pending" || (inv.expires_at && now() > inv.expires_at)) {
      return c.html(signupPage(code, inv ?? ({} as Invite), "This invite is no longer valid."), 410);
    }
    if (rateLimited("invite:" + clientIp(c))) {
      return c.html(signupPage(code, inv, "Too many attempts — please wait a few minutes."), 429);
    }
    const form = await c.req.parseBody();
    const email = (inv.email || String(form.email ?? "")).trim().toLowerCase();
    const username = String(form.username ?? "").trim();
    const password = String(form.password ?? "");
    if (!email) return c.html(signupPage(code, inv, "Email is required."));
    if (inv.email && email !== inv.email) return c.html(signupPage(code, inv, "This invite is for a different email."));
    if (password.length < 12) return c.html(signupPage(code, inv, "Password must be at least 12 characters."));

    // Authorize + create the user via the normal email path.
    addAllow("email", email, sanitizeUsername(username || inv.suggested_username || email.split("@")[0]));
    const res = await resolveEmailLogin(email, password);
    if ("error" in res) return c.html(signupPage(code, inv, "Could not create account (" + res.error + ")."));
    if (inv.role === "admin") db.run("UPDATE users SET is_admin = 1 WHERE id = ?", [res.user.id]);
    db.run("UPDATE invites SET status='accepted', accepted_user_id=?, accepted_at=? WHERE id=?", [res.user.id, now(), inv.id]);

    // New accounts start unverified (soft). Nudge them to confirm; non-blocking.
    try {
      const vraw = createToken(res.user.id, "verify_email", 24 * 3600);
      void sendVerifyEmail(email, `${config.publicBaseUrl}/verify/${vraw}`);
    } catch { /* email is best-effort; never block signup */ }

    const token = await signSession({ sub: res.user.id, username: res.user.username, provider: "email", admin: inv.role === "admin" || !!res.user.is_admin });
    setSessionCookie(c, token);
    return c.redirect("/worlds?msg=" + encodeURIComponent("Welcome, " + res.user.username + "! Set your in-game username to match, then play."));
  });
}
