// Shared page shell: top tab bar + consistent dark theme. Every server-rendered
// page uses shell(); the static play client mirrors the same markup/CSS.

export function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export const SHARED_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8eaed;
  background:radial-gradient(1100px 520px at 50% -8%,#16241c 0%,transparent 55%),#0b0d10;min-height:100vh}
a{color:#7fb3ff;text-decoration:none}
.nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:.4rem;padding:.6rem 1rem;
  background:rgba(13,15,18,.85);backdrop-filter:blur(8px);border-bottom:1px solid #1c2230}
.brand{font-weight:700;letter-spacing:-.02em;margin-right:.6rem;white-space:nowrap}
.tabs{display:flex;gap:.2rem;flex:1;flex-wrap:wrap}
.tab{padding:.4rem .75rem;border-radius:8px;color:#aeb6c2;font-weight:600;font-size:.92rem}
.tab:hover{background:#161b24;color:#e8eaed}
.tab.active{background:#21402f;color:#dcf5e6}
.tab-btn{background:none;border:none;font:inherit;padding:.4rem .75rem;border-radius:8px;color:#aeb6c2;font-weight:600;font-size:.92rem;cursor:pointer}
.tab-btn:hover{background:#161b24;color:#e8eaed}
.acct{display:flex;align-items:center;gap:.6rem;color:#8b95a3;font-size:.88rem;white-space:nowrap}
.acct b{color:#e8eaed}
.acct .badge{font-size:.62rem}
.wrap{max-width:860px;margin:1.6rem auto;padding:0 1rem 4rem}
h1{font-size:1.5rem;margin:.2rem 0 .2rem}
h2{font-size:1.05rem;margin:2rem 0 .6rem;color:#cdd6e2}
.sub{color:#8b95a3;margin:0 0 1.2rem}
.card{background:#14171d;border:1px solid #232a35;border-radius:14px;padding:1.1rem 1.2rem;margin:.6rem 0}
.muted,.hint{color:#8b95a3}.hint{font-size:.88rem}
code{background:#0f1217;border:1px solid #232a35;border-radius:6px;padding:.1rem .4rem;font-family:ui-monospace,monospace;font-size:.84rem;color:#a8e6c0}
input,select,button,textarea{font:inherit;padding:.55rem .7rem;border-radius:9px;border:1px solid #2c333f;background:#161a22;color:#e8eaed}
input:focus,select:focus,textarea:focus{outline:none;border-color:#3a7a57;box-shadow:0 0 0 3px rgba(58,122,87,.18)}
input::placeholder{color:#6b7585}
/* custom-caret select (replaces the native OS dropdown chrome) */
select{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:1.95rem;
  background:#161a22 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b95a3' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") no-repeat right .65rem center}
select:hover{border-color:#39414f}
/* toggle switch (styled checkbox) */
.switch{position:relative;display:inline-flex;align-items:center;gap:.55rem;cursor:pointer;user-select:none;color:#cdd6e2;font-size:.9rem;white-space:nowrap}
.switch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.switch .track{position:relative;flex:none;width:40px;height:22px;border-radius:999px;background:#2c333f;border:1px solid #39414f;transition:background .15s,border-color .15s}
.switch .track::after{content:"";position:absolute;top:50%;left:2px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#cdd6e2;transition:left .15s,background .15s}
.switch:hover .track{border-color:#4a5365}
.switch input:checked + .track{background:#2f6f4f;border-color:#357a57}
.switch input:checked + .track::after{left:20px;background:#fff}
.switch input:focus-visible + .track{box-shadow:0 0 0 3px rgba(47,111,79,.45)}
/* label + control pairs sitting inline in a row */
.inline-field{display:inline-flex;align-items:center;gap:.45rem;color:#8b95a3;font-size:.9rem;white-space:nowrap}
textarea{width:100%;min-height:320px;font-family:ui-monospace,monospace;font-size:.9rem;line-height:1.5;resize:vertical}
button{cursor:pointer;font-weight:600}
.pill{display:inline-block;background:#1b2029;border:1px solid #2c333f;border-radius:8px;padding:.35rem .65rem;color:#cdd6e2;font-size:.83rem;font-weight:600}
.pill:hover{background:#222834;color:#fff}
.btn-primary{background:#2f6f4f;border-color:#357a57;color:#fff}
.btn-primary:hover{background:#357f5a}
.btn-ghost{background:#1b2029;border-color:#2c333f}
.btn-danger{background:#5a2230;border-color:#7a2f40;font-size:.85rem;padding:.35rem .6rem}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.4rem 0}
.row input,.row select{flex:1;min-width:140px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:.45rem .5rem;border-bottom:1px solid #20252f;vertical-align:middle}
th{color:#8b95a3;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em}
/* Pill badges. Base carries ALL the shape (padding, radius, font); variants
   only recolor — so a variant must always be paired with the base .badge. */
.badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.02em;line-height:1.4;
  background:#2f4f7f;color:#dce8ff;padding:.12rem .5rem;border-radius:999px;vertical-align:middle;white-space:nowrap}
.badge-ok{background:#234e36;color:#bff0d0}
.badge-owner{background:#4a3a1e;color:#ffd98a}
.badge-admin{background:#234e36;color:#bff0d0}
.badge-member{background:#222a35;color:#9aa4b2}
.badge-muted{background:#3a2a2f;color:#e6b9c4}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:#3a4250;margin-right:.35rem;vertical-align:middle}
.dot.on{background:#46d17f;box-shadow:0 0 6px #46d17f}
.flash{background:#1d3a28;border:1px solid #2f6f4f;color:#cdeede;padding:.55rem .85rem;border-radius:9px;margin:.6rem 0;word-break:break-word}
.flash-err{background:#3a1d24;border:1px solid #6b2c39;color:#ffb3c0}
.world{background:#14171d;border:1px solid #232a35;border-radius:12px;padding:.9rem 1rem;margin:.55rem 0}
/* wider container for dense admin tables (desktop) */
.wrap.wide{max-width:1120px}
.nowrap{white-space:nowrap}
/* invite-status filter tabs */
.filters{display:flex;gap:.35rem;flex-wrap:wrap;margin:.2rem 0 .6rem}
.filters a{padding:.3rem .65rem;border-radius:999px;border:1px solid #2c333f;color:#aeb6c2;font-size:.83rem;font-weight:600}
.filters a:hover{background:#161b24;color:#e8eaed}
.filters a.on{background:#21402f;border-color:#357a57;color:#dcf5e6}
/* ── phones ─────────────────────────────────────────────────────────────── */
@media (max-width:640px){
  .nav{flex-wrap:wrap;gap:.35rem;padding:.55rem .8rem}
  .brand{order:1;margin-right:auto}
  .acct{order:2}
  .tabs{order:3;width:100%;margin-top:.15rem}
  .wrap{margin:1.1rem auto;padding:0 .8rem 3rem}
  h1{font-size:1.3rem}
  /* opt-in stacked-card tables: each row becomes a labelled card */
  table.adm thead{position:absolute;left:-9999px}
  table.adm tr{display:block;border:1px solid #232a35;border-radius:11px;padding:.5rem .75rem;margin:.55rem 0;background:#14171d}
  table.adm td{display:flex;justify-content:space-between;gap:.75rem;align-items:center;border:0;padding:.3rem 0;text-align:right;word-break:break-word}
  table.adm td::before{content:attr(data-label);color:#8b95a3;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;text-align:left;flex:none}
  table.adm td:empty{display:none}
  table.adm td[data-label=""]::before{content:""}
  table.adm td > div{flex-wrap:wrap;justify-content:flex-end}
}
`;

interface ShellOpts {
  title: string;
  active: string; // play | worlds | admin | guide | profile
  username: string;
  admin: boolean;
  body: string;
  msg?: string | null;
  err?: string | null;
  wide?: boolean; // use the wider container (dense admin tables)
}

export function shell(o: ShellOpts): string {
  const tab = (id: string, href: string, label: string, key?: string) =>
    `<a class="tab${o.active === id ? " active" : ""}" href="${href}"${key ? ` title="Shortcut: ${key}"` : ""}>${label}</a>`;
  // Single-key nav shortcuts (ignored while typing). 'a' only for admins.
  const navKeys: Record<string, string> = { w: "/worlds", f: "/friends", g: "/help", p: "/profile", y: "/" };
  if (o.admin) navKeys.a = "/admin";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/email-logo.png"/>
<title>${esc(o.title)}</title><style>${SHARED_CSS}</style></head><body>
<nav class="nav">
  <span class="brand">⛏ Minecraft</span>
  <div class="tabs">
    ${tab("play", "/", "Play", "Y")}
    ${tab("worlds", "/worlds", "Worlds", "W")}
    ${tab("friends", "/friends", "Friends", "F")}
    ${o.admin ? tab("admin", "/admin", "Admin", "A") : ""}
    ${tab("guide", "/help", "Guide", "G")}
    ${tab("profile", "/profile", "Profile", "P")}
  </div>
  <div class="acct"><span><b>${esc(o.username)}</b>${o.admin ? ' <span class="badge badge-admin">admin</span>' : ""}</span><form method="post" action="/logout" style="margin:0;display:inline"><button class="tab-btn" type="submit">Log out</button></form></div>
</nav>
<div class="wrap${o.wide ? " wide" : ""}">
  ${o.msg ? `<div class="flash">${esc(o.msg)}</div>` : ""}
  ${o.err ? `<div class="flash flash-err">${esc(o.err)}</div>` : ""}
  ${o.body}
</div>
<script>(function(){var m=${JSON.stringify(navKeys)};document.addEventListener("keydown",function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;var t=e.target||{},n=(t.tagName||"").toUpperCase();if(n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||t.isContentEditable)return;var d=m[(e.key||"").toLowerCase()];if(d){e.preventDefault();location.href=d;}});})();</script>
</body></html>`;
}
