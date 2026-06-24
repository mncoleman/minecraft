import type { Hono } from "hono";
import { currentSession, setSessionCookie } from "./session.ts";
import { db, hashPassword, createToken, emailInUse, renameUser, type User } from "./db.ts";
import { config } from "./config.ts";
import { clientIp, rateLimited } from "./session.ts";
import { sendEmailChange, sendVerifyEmail } from "./mailer.ts";
import { signSession } from "./jwt.ts";
import { transferInGameIdentity } from "./worlds.ts";
import { shell, esc } from "./layout.ts";

const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function profilePage(u: User, msg?: string, err?: string): string {
  const owner = (u.email || "").toLowerCase() === OWNER_EMAIL;
  const role = owner ? "owner" : u.is_admin ? "admin" : "member";
  const links = [
    u.email ? "email" : null,
    u.telegram_id ? "telegram" : null,
    u.google_sub ? "google" : null,
  ].filter(Boolean).join(", ") || "—";

  const verifyBadge = u.email
    ? (u.email_verified
        ? ' <span class="badge badge-ok">verified</span>'
        : ' <span class="badge">unverified</span>')
    : "";

  const body = `
    <h1>Profile</h1>
    <p class="sub">Your account and in-game identity.</p>
    <div class="card">
      <table>
        <tr><td>In-game username</td><td><b>${esc(u.username)}</b><div class="hint">Set this exact name in the client (Main menu → Edit Profile → Username) or you'll be asked to. You can change it below.</div></td></tr>
        <tr><td>Email</td><td>${u.email ? esc(u.email) + verifyBadge : '<span class="hint">—</span>'}</td></tr>
        <tr><td>Role</td><td><span class="badge${role === "member" ? "" : "-ok"}">${esc(role)}</span></td></tr>
        <tr><td>Sign-in methods</td><td class="hint">${esc(links)}</td></tr>
        <tr><td>Joined</td><td class="hint">${u.created_at ? new Date(u.created_at * 1000).toISOString().slice(0, 10) : ""}</td></tr>
      </table>
    </div>

    ${owner ? "" : `
    <h2>Change username</h2>
    <div class="card">
      <form method="post" action="/profile/username" style="display:grid;gap:.6rem;max-width:340px"
            onsubmit="return confirm('Change your username to what you typed?\\n\\nYour builds and world access carry over, but your in-game inventory, position and XP reset. You will be disconnected from the game and must set the new name in Edit Profile.')">
        <input name="username" placeholder="new username (3–16, letters/numbers/_)" minlength="3" maxlength="16" autocomplete="off" required/>
        ${u.password_hash ? '<input type="password" name="current" placeholder="current password" autocomplete="current-password" required/>' : ""}
        <button class="btn-primary" style="justify-self:start">Change username</button>
      </form>
      <p class="hint" style="margin:.5rem 0 0">Your builds and access to every world carry over. Your in-game inventory, position and XP reset to a fresh start, and you'll be signed out of the game — reconnect and set the new name in <b>Edit Profile</b>.</p>
    </div>`}

    <h2>Change email</h2>
    <div class="card">
      <form method="post" action="/profile/email" style="display:grid;gap:.6rem;max-width:340px">
        <input type="email" name="email" placeholder="new email" required/>
        ${u.password_hash ? '<input type="password" name="current" placeholder="current password" autocomplete="current-password" required/>' : ""}
        <button class="btn-primary" style="justify-self:start">Send confirmation</button>
      </form>
      <p class="hint" style="margin:.5rem 0 0">We email a confirmation link to the new address. The change only takes effect after you click it.</p>
      ${u.email && !u.email_verified ? `
      <form method="post" action="/profile/verify" style="margin:.8rem 0 0">
        <button class="btn-ghost" style="justify-self:start">Resend verification to ${esc(u.email)}</button>
      </form>` : ""}
    </div>

    ${u.password_hash ? `
    <h2>Change password</h2>
    <div class="card">
      <form method="post" action="/profile/password" style="display:grid;gap:.6rem;max-width:340px">
        <input type="password" name="current" placeholder="current password" autocomplete="current-password" required/>
        <input type="password" name="next" placeholder="new password (min 12 chars)" minlength="12" autocomplete="new-password" required/>
        <button class="btn-primary" style="justify-self:start">Update password</button>
      </form>
      <p class="hint" style="margin:.5rem 0 0">Forgot it? <a href="/forgot">Reset by email</a>.</p>
    </div>` : ""}
  `;
  return shell({ title: "Profile", active: "profile", username: u.username, admin: !!u.is_admin, body, msg, err });
}

export function mountProfile(app: Hono): void {
  app.get("/profile", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const u = db.query("SELECT * FROM users WHERE id = ?").get(s.sub) as User | null;
    if (!u) return c.redirect("/login");
    return c.html(profilePage(u, c.req.query("msg"), c.req.query("err")));
  });

  app.post("/profile/password", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const u = db.query("SELECT * FROM users WHERE id = ?").get(s.sub) as User | null;
    if (!u || !u.password_hash) return c.redirect("/profile?err=" + encodeURIComponent("No password set on this account."));
    const form = await c.req.parseBody();
    const current = String(form.current ?? "");
    const next = String(form.next ?? "");
    if (next.length < 12) return c.redirect("/profile?err=" + encodeURIComponent("New password must be at least 12 characters."));
    if (!(await Bun.password.verify(current, u.password_hash))) {
      return c.redirect("/profile?err=" + encodeURIComponent("Current password is incorrect."));
    }
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(next), u.id]);
    return c.redirect("/profile?msg=" + encodeURIComponent("Password updated."));
  });

  // Self-service username change. Transfers in-game access (re-grants under the
  // new offline UUID) and re-signs the session cookie so the new name takes effect
  // immediately. The owner can't be renamed (their in-game op is keyed by name).
  app.post("/profile/username", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const u = db.query("SELECT * FROM users WHERE id = ?").get(s.sub) as User | null;
    if (!u) return c.redirect("/login");
    if ((u.email || "").toLowerCase() === OWNER_EMAIL) {
      return c.redirect("/profile?err=" + encodeURIComponent("The owner username can't be changed."));
    }
    if (rateLimited("rename:" + clientIp(c))) {
      return c.redirect("/profile?err=" + encodeURIComponent("Too many attempts. Wait a few minutes."));
    }
    const form = await c.req.parseBody();
    // If the account has a password, require it to authorize the change.
    if (u.password_hash) {
      const current = String(form.current ?? "");
      if (!(await Bun.password.verify(current, u.password_hash))) {
        return c.redirect("/profile?err=" + encodeURIComponent("Current password is incorrect."));
      }
    }
    const result = renameUser(u.id, String(form.username ?? ""));
    if ("error" in result) return c.redirect("/profile?err=" + encodeURIComponent(result.error));

    await transferInGameIdentity(u.id, result.oldUsername, result.newUsername);
    // Re-sign the session so forward_auth + the in-game JWT lock use the new name.
    const token = await signSession({ sub: u.id, username: result.newUsername, provider: s.provider, admin: !!u.is_admin });
    setSessionCookie(c, token);
    return c.redirect("/profile?msg=" + encodeURIComponent(
      `Username changed to ${result.newUsername}. Reconnect to the game and set this exact name in Edit Profile.`));
  });

  // Request an email change: confirm-by-link to the NEW address. Nothing changes
  // until that link is clicked (handled in account.ts /verify/:token).
  app.post("/profile/email", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const u = db.query("SELECT * FROM users WHERE id = ?").get(s.sub) as User | null;
    if (!u) return c.redirect("/login");
    if (rateLimited("emailchange:" + clientIp(c))) {
      return c.redirect("/profile?err=" + encodeURIComponent("Too many attempts. Wait a few minutes."));
    }
    const form = await c.req.parseBody();
    const email = String(form.email ?? "").trim().toLowerCase();
    // If the account has a password, require it to authorize the change.
    if (u.password_hash) {
      const current = String(form.current ?? "");
      if (!(await Bun.password.verify(current, u.password_hash))) {
        return c.redirect("/profile?err=" + encodeURIComponent("Current password is incorrect."));
      }
    }
    if (!EMAIL_RE.test(email)) return c.redirect("/profile?err=" + encodeURIComponent("Enter a valid email address."));
    if (email === (u.email || "").toLowerCase()) return c.redirect("/profile?err=" + encodeURIComponent("That is already your email."));
    if (emailInUse(email, u.id)) return c.redirect("/profile?err=" + encodeURIComponent("That email is already in use."));

    const raw = createToken(u.id, "change_email", 24 * 3600, email);
    const res = await sendEmailChange(email, `${config.publicBaseUrl}/verify/${raw}`);
    if (!res.ok) return c.redirect("/profile?err=" + encodeURIComponent("Could not send the confirmation email. Try again later."));
    return c.redirect("/profile?msg=" + encodeURIComponent("Confirmation sent to " + email + ". Click the link there to finish."));
  });

  // Resend a verification link to the user's current email.
  app.post("/profile/verify", async (c) => {
    const s = await currentSession(c);
    if (!s) return c.redirect("/login");
    const u = db.query("SELECT * FROM users WHERE id = ?").get(s.sub) as User | null;
    if (!u) return c.redirect("/login");
    if (!u.email) return c.redirect("/profile?err=" + encodeURIComponent("No email on this account."));
    if (u.email_verified) return c.redirect("/profile?msg=" + encodeURIComponent("Your email is already verified."));
    if (rateLimited("verifyemail:" + clientIp(c))) {
      return c.redirect("/profile?err=" + encodeURIComponent("Too many attempts. Wait a few minutes."));
    }
    const raw = createToken(u.id, "verify_email", 24 * 3600);
    const res = await sendVerifyEmail(u.email, `${config.publicBaseUrl}/verify/${raw}`);
    if (!res.ok) return c.redirect("/profile?err=" + encodeURIComponent("Could not send the email. Try again later."));
    return c.redirect("/profile?msg=" + encodeURIComponent("Verification sent to " + u.email + "."));
  });
}
