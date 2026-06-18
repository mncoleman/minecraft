import type { Hono, Context } from "hono";
import { currentSession } from "./session.ts";
import { db, hashPassword, type User } from "./db.ts";
import { config } from "./config.ts";
import { shell, esc } from "./layout.ts";

const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

function profilePage(u: User, msg?: string, err?: string): string {
  const owner = (u.email || "").toLowerCase() === OWNER_EMAIL;
  const role = owner ? "owner" : u.is_admin ? "admin" : "member";
  const links = [
    u.email ? "email" : null,
    u.telegram_id ? "telegram" : null,
    u.google_sub ? "google" : null,
  ].filter(Boolean).join(", ") || "—";

  const body = `
    <h1>Profile</h1>
    <p class="sub">Your account and in-game identity.</p>
    <div class="card">
      <table>
        <tr><td>In-game username</td><td><b>${esc(u.username)}</b><div class="hint">Set this exact name in the client (Main menu → Edit Profile → Username) or you'll be asked to.</div></td></tr>
        <tr><td>Email</td><td>${u.email ? esc(u.email) : '<span class="hint">—</span>'}</td></tr>
        <tr><td>Role</td><td><span class="badge${role === "member" ? "" : "-ok"}">${esc(role)}</span></td></tr>
        <tr><td>Sign-in methods</td><td class="hint">${esc(links)}</td></tr>
        <tr><td>Joined</td><td class="hint">${u.created_at ? new Date(u.created_at * 1000).toISOString().slice(0, 10) : ""}</td></tr>
      </table>
    </div>
    ${u.password_hash ? `
    <h2>Change password</h2>
    <div class="card">
      <form method="post" action="/profile/password" style="display:grid;gap:.6rem;max-width:340px">
        <input type="password" name="current" placeholder="current password" required/>
        <input type="password" name="next" placeholder="new password (min 12 chars)" minlength="12" required/>
        <button class="btn-primary" style="justify-self:start">Update password</button>
      </form>
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
}
