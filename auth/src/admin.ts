import type { Hono, Context } from "hono";
import { currentSession } from "./session.ts";
import { db, type User } from "./db.ts";
import { config } from "./config.ts";
import { shell, esc } from "./layout.ts";
import { listInvites } from "./invites.ts";
import { listAllWorlds, sharesForWorld, isProtectedWorld } from "./worlds.ts";
import { getPresence } from "./presence.ts";

const OWNER_EMAIL = (config.adminEmails[0] || "").toLowerCase();

async function meAdmin(c: Context) {
  const s = await currentSession(c);
  if (!s?.admin) return null;
  const u = db.query("SELECT email FROM users WHERE id = ?").get(s.sub) as { email: string | null } | null;
  const owner = !!u?.email && u.email.toLowerCase() === OWNER_EMAIL;
  return { sub: s.sub, username: s.username, owner };
}

const INVITE_FILTERS = ["pending", "accepted", "revoked", "all"] as const;
type InviteFilter = (typeof INVITE_FILTERS)[number];

function adminPage(me: { sub: string; username: string; owner: boolean }, online: Set<string>, inviteFilter: InviteFilter, msg?: string, err?: string): string {
  const users = db.query("SELECT * FROM users ORDER BY created_at").all() as User[];
  const invites = listInvites();
  const worlds = listAllWorlds();
  const userById = (id: string) => users.find((u) => u.id === id);

  // Invite filter (default pending) + per-status counts for the filter tabs.
  const counts = { pending: 0, accepted: 0, revoked: 0, all: invites.length } as Record<InviteFilter, number>;
  for (const iv of invites) if (iv.status in counts) counts[iv.status as InviteFilter]++;
  const shownInvites = inviteFilter === "all" ? invites : invites.filter((iv) => iv.status === inviteFilter);
  const filterTabs = `<div class="filters">${INVITE_FILTERS.map((f) =>
    `<a class="${f === inviteFilter ? "on" : ""}" href="/admin?invites=${f}">${f[0].toUpperCase() + f.slice(1)} (${counts[f]})</a>`).join("")}</div>`;

  const acceptedWhen = (at: number | null) => (at ? new Date(at * 1000).toISOString().slice(0, 10) : "");
  const statusCell = (iv: (typeof invites)[number]) => {
    if (iv.status === "accepted") {
      const who = iv.accepted_username ? esc(iv.accepted_username) : "user removed";
      const when = acceptedWhen(iv.accepted_at);
      return `<span class="badge badge-ok">accepted</span><div class="hint" style="margin-top:.25rem">by ${who}${when ? " · " + when : ""}</div>`;
    }
    if (iv.status === "revoked") return '<span class="badge badge-muted">revoked</span>';
    return '<span class="badge">pending</span>';
  };

  const inviteRows = shownInvites.map((iv) =>
    `<tr>
      <td data-label="Invite">${iv.email ? esc(iv.email) : '<span class="hint">(open link)</span>'}${iv.status === "pending" ? `<br><code style="font-size:.72rem">${esc(config.publicBaseUrl + "/invite/" + iv.code)}</code>` : ""}</td>
      <td data-label="Role">${esc(iv.role)}</td>
      <td data-label="Status">${statusCell(iv)}</td>
      <td data-label="" style="text-align:right">${iv.status === "pending" ? `<form method="post" action="/admin/invites/${esc(iv.code)}/revoke" style="margin:0"><button class="btn-danger">revoke</button></form>` : ""}</td>
    </tr>`).join("");

  const userRows = users.map((u) => {
    const isOwnerRow = (u.email || "").toLowerCase() === OWNER_EMAIL;
    const roleForm = me.owner && !isOwnerRow
      ? `<form method="post" action="/admin/users/${u.id}/role" style="margin:0;display:inline"><input type="hidden" name="is_admin" value="${u.is_admin ? 0 : 1}"/><button class="btn-ghost">${u.is_admin ? "demote" : "make admin"}</button></form>`
      : "";
    // Admins can delete users; the owner is never deletable, you can't delete
    // yourself, and only the owner can delete another admin.
    const canDelete = !isOwnerRow && u.id !== me.sub && (me.owner || !u.is_admin);
    const deleteForm = canDelete
      ? `<form method="post" action="/admin/users/${u.id}/delete" style="margin:0;display:inline" onsubmit="return confirm('Delete ${esc(u.username)}? This permanently removes their account and revokes all access. They must not own any worlds. This cannot be undone.')"><button class="btn-danger">delete</button></form>`
      : "";
    // Admins can rename any non-owner. The target keeps their worlds, shares and
    // builds; in-game access is re-granted under the new name. They must re-login
    // for it to take effect in their own game session (we can't rotate their cookie).
    const renameForm = !isOwnerRow
      ? `<form method="post" action="/admin/users/${u.id}/username" style="margin:0;display:inline-flex;gap:.3rem" onsubmit="return confirm('Rename ${esc(u.username)}? Everything carries over — worlds, shares, builds, and their full in-game character (inventory, position, XP). ${esc(u.username)} must sign out and back in for it to take effect in-game.')"><input name="username" placeholder="new name" minlength="3" maxlength="16" style="width:7.5rem;padding:.3rem .5rem;font-size:.85rem" required/><button class="btn-ghost" style="padding:.3rem .55rem;font-size:.85rem">rename</button></form>`
      : "";
    return `<tr>
      <td data-label="Player"><span class="dot ${online.has(u.username.toLowerCase()) ? "on" : ""}"></span><b>${esc(u.username)}</b>${u.is_admin ? ' <span class="badge badge-admin">admin</span>' : ""}</td>
      <td data-label="Email" class="hint">${u.email ? esc(u.email) : "—"}</td>
      <td data-label="Last login" class="hint nowrap">${u.last_login_at ? new Date(u.last_login_at * 1000).toISOString().slice(0, 10) : "never"}</td>
      <td data-label="" style="text-align:right"><div style="display:inline-flex;gap:.4rem;justify-content:flex-end;flex-wrap:wrap;align-items:center">${renameForm}${roleForm}${deleteForm}</div></td>
    </tr>`;
  }).join("");

  const body = `
    <h1>Admin</h1>
    <p class="sub">Invite people, manage roles, and see every world. Only you and admins can invite.</p>

    <h2>Invite a friend</h2>
    <div class="card">
      <form method="post" action="/admin/invites">
        <div class="row">
          <input name="email" type="email" placeholder="friend's email (optional)" autocomplete="off"/>
          <input name="suggested_username" placeholder="suggested username (optional)" autocomplete="off"/>
        </div>
        <div class="row" style="margin-top:.6rem">
          ${me.owner ? `<label class="inline-field">Role<select name="role" style="flex:none;min-width:130px"><option value="user">user</option><option value="admin">admin</option></select></label>` : ""}
          <label class="switch"><input type="checkbox" name="send_email" value="1"/><span class="track"></span><span>Email the invite</span></label>
          <button class="btn-primary" style="margin-left:auto">Create invite link</button>
        </div>
      </form>
      <p class="hint" style="margin:.7rem 0 0">Share the generated link; they pick a username + password and they're in. Turn on "Email the invite" (needs an email) to have us send it for you.</p>
    </div>
    <h2>Invites</h2>
    ${filterTabs}
    ${shownInvites.length
      ? `<table class="adm"><thead><tr><th>Invite</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${inviteRows}</tbody></table>`
      : `<p class="hint">No ${inviteFilter === "all" ? "" : inviteFilter + " "}invites${inviteFilter === "all" ? " yet" : ""}.</p>`}

    <h2>Users (${users.length})</h2>
    <table class="adm"><thead><tr><th>Player</th><th>Email</th><th>Last login</th><th></th></tr></thead><tbody>${userRows}</tbody></table>

    <h2>All worlds (${worlds.length})</h2>
    ${worlds.length ? worlds.map((w) => {
      const o = userById(w.owner_user_id);
      const opts = users.filter((u) => u.id !== w.owner_user_id).map((u) => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join("");
      const shared = sharesForWorld(w.id).length;
      const del = isProtectedWorld(w.mv_world_name)
        ? '<span class="hint" title="The lobby and seeded worlds can\'t be deleted">protected</span>'
        : `<button type="button" class="btn-danger mc-del" data-id="${w.id}" data-name="${esc(w.name)}" data-mv="${esc(w.mv_world_name)}" data-shared="${shared}">Delete</button>`;
      return `<div class="world">
        <div class="row" style="justify-content:space-between;margin:0;gap:.5rem">
          <span><b>${esc(w.name)}</b> <code>${esc(w.mv_world_name)}</code> <span class="hint">owner: ${esc(o?.username || "?")} · ${shared} shared</span></span>
          <span class="row" style="margin:0;gap:.4rem">
            ${opts
              ? `<form method="post" action="/worlds/${w.id}/reassign" class="row" style="margin:0" onsubmit="return confirm('Reassign ${esc(w.name)} to the selected user? The current owner becomes a shared build member, and you can then delete them if needed.')">
                   <select name="username" required style="min-width:120px">${opts}</select>
                   <button class="btn-ghost">Reassign</button>
                 </form>`
              : ""}
            ${del}
          </span>
        </div>
      </div>`;
    }).join("") : '<p class="hint">none</p>'}

    <div class="modal-overlay" id="del-modal">
      <div class="modal">
        <h3>Delete world <span id="dm-name"></span>?</h3>
        <p class="hint" style="margin:0 0 .7rem">This <b>permanently</b> deletes the world and <b>every build in it</b>, and removes access for the owner and everyone it's shared with (<span id="dm-shared">0</span> shared). This cannot be undone.</p>
        <p style="margin:0 0 .35rem">Type <code id="dm-mv"></code> to confirm:</p>
        <form method="post" id="dm-form">
          <input id="dm-input" name="confirm" autocomplete="off" placeholder="world name" style="width:100%"/>
          <div class="row" style="justify-content:flex-end;margin-top:.85rem">
            <button class="btn-ghost" type="button" id="dm-cancel">Cancel</button>
            <button class="btn-danger" id="dm-confirm" type="submit" disabled>Delete world</button>
          </div>
        </form>
      </div>
    </div>
    <script>(function(){
      var modal=document.getElementById("del-modal"),nameEl=document.getElementById("dm-name"),mvEl=document.getElementById("dm-mv"),
          sharedEl=document.getElementById("dm-shared"),form=document.getElementById("dm-form"),inp=document.getElementById("dm-input"),
          confirmBtn=document.getElementById("dm-confirm");
      function close(){modal.classList.remove("open");}
      document.getElementById("dm-cancel").onclick=close;
      modal.addEventListener("click",function(e){if(e.target===modal)close();});
      inp.addEventListener("input",function(){confirmBtn.disabled=inp.value!==mvEl.textContent;});
      Array.prototype.forEach.call(document.querySelectorAll(".mc-del"),function(b){
        b.onclick=function(){
          nameEl.textContent=b.dataset.name;mvEl.textContent=b.dataset.mv;sharedEl.textContent=b.dataset.shared;
          form.action="/worlds/"+b.dataset.id+"/delete";inp.value="";confirmBtn.disabled=true;
          modal.classList.add("open");inp.focus();
        };
      });
    })();</script>
  `;
  return shell({ title: "Admin", active: "admin", username: me.username, admin: true, body, msg, err, wide: true });
}

export function mountAdmin(app: Hono): void {
  app.get("/admin", async (c) => {
    const m = await meAdmin(c);
    if (!m) return c.redirect("/worlds?err=" + encodeURIComponent("Admins only."));
    const online = new Set((await getPresence()).map((p) => p.name.toLowerCase()));
    const q = c.req.query("invites");
    const filter: InviteFilter = (INVITE_FILTERS as readonly string[]).includes(q ?? "") ? (q as InviteFilter) : "pending";
    return c.html(adminPage(m, online, filter, c.req.query("msg"), c.req.query("err")));
  });
}
