import type { Hono, Context } from "hono";
import { currentSession } from "./session.ts";
import { db, type User } from "./db.ts";
import { config } from "./config.ts";
import { shell, esc } from "./layout.ts";
import { listInvites } from "./invites.ts";
import { listAllWorlds, sharesForWorld } from "./worlds.ts";
import { getPresence } from "./presence.ts";

const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

async function meAdmin(c: Context) {
  const s = await currentSession(c);
  if (!s?.admin) return null;
  const u = db.query("SELECT email FROM users WHERE id = ?").get(s.sub) as { email: string | null } | null;
  const owner = !!u?.email && u.email.toLowerCase() === OWNER_EMAIL;
  return { sub: s.sub, username: s.username, owner };
}

function adminPage(me: { username: string; owner: boolean }, online: Set<string>, msg?: string, err?: string): string {
  const users = db.query("SELECT * FROM users ORDER BY created_at").all() as User[];
  const invites = listInvites();
  const worlds = listAllWorlds();
  const userById = (id: string) => users.find((u) => u.id === id);

  const inviteRows = invites.map((iv) =>
    `<tr>
      <td>${iv.email ? esc(iv.email) : '<span class="hint">(open link)</span>'}${iv.status === "pending" ? `<br><code style="font-size:.72rem">${esc(config.publicBaseUrl + "/invite/" + iv.code)}</code>` : ""}</td>
      <td>${esc(iv.role)}</td>
      <td>${iv.status === "accepted" ? '<span class="badge badge-ok">accepted</span>' : iv.status === "revoked" ? '<span class="hint">revoked</span>' : '<span class="badge">pending</span>'}</td>
      <td style="text-align:right">${iv.status === "pending" ? `<form method="post" action="/admin/invites/${esc(iv.code)}/revoke" style="margin:0"><button class="btn-danger">revoke</button></form>` : ""}</td>
    </tr>`).join("");

  const userRows = users.map((u) =>
    `<tr>
      <td><span class="dot ${online.has(u.username.toLowerCase()) ? "on" : ""}"></span><b>${esc(u.username)}</b>${u.is_admin ? ' <span class="badge">admin</span>' : ""}</td>
      <td class="hint">${u.email ? esc(u.email) : "—"}</td>
      <td class="hint">${u.last_login_at ? new Date(u.last_login_at * 1000).toISOString().slice(0, 10) : "never"}</td>
      <td style="text-align:right">${me.owner && (u.email || "").toLowerCase() !== OWNER_EMAIL ? `<form method="post" action="/admin/users/${u.id}/role" style="margin:0"><input type="hidden" name="is_admin" value="${u.is_admin ? 0 : 1}"/><button class="btn-ghost">${u.is_admin ? "demote" : "make admin"}</button></form>` : ""}</td>
    </tr>`).join("");

  const body = `
    <h1>Admin</h1>
    <p class="sub">Invite people, manage roles, and see every world. Only you and admins can invite.</p>

    <h2>Invite a friend</h2>
    <div class="card">
      <form method="post" action="/admin/invites" class="row">
        <input name="email" placeholder="friend's email (optional)"/>
        <input name="suggested_username" placeholder="suggested username (optional)"/>
        ${me.owner ? `<select name="role"><option value="user">user</option><option value="admin">admin</option></select>` : ""}
        <button class="btn-primary">Create invite link</button>
      </form>
      <p class="hint" style="margin:.5rem 0 0">Share the generated link; they pick a username + password and they're in.</p>
    </div>
    ${invites.length ? `<table><thead><tr><th>Invite</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table>` : '<p class="hint">No invites yet.</p>'}

    <h2>Users (${users.length})</h2>
    <table><thead><tr><th>Player</th><th>Email</th><th>Last login</th><th></th></tr></thead><tbody>${userRows}</tbody></table>

    <h2>All worlds (${worlds.length})</h2>
    ${worlds.length ? worlds.map((w) => { const o = userById(w.owner_user_id); return `<div class="world"><b>${esc(w.name)}</b> <code>${esc(w.mv_world_name)}</code> <span class="hint">owner: ${esc(o?.username || "?")} · ${sharesForWorld(w.id).length} shared</span></div>`; }).join("") : '<p class="hint">none</p>'}
  `;
  return shell({ title: "Admin", active: "admin", username: me.username, admin: true, body, msg, err });
}

export function mountAdmin(app: Hono): void {
  app.get("/admin", async (c) => {
    const m = await meAdmin(c);
    if (!m) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const online = new Set((await getPresence()).map((p) => p.name.toLowerCase()));
    return c.html(adminPage(m, online, c.req.query("msg"), c.req.query("err")));
  });
}
